/** Runs one owner-conversation repair turn for an automation past its failure-alert threshold. */
import { randomUUID } from "node:crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { wrapUntrustedPromptDataBlock } from "../agents/sanitize-for-prompt.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { CliDeps } from "../cli/deps.types.js";
import { readSessionEntryInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import { projectCronRunHistoryPage } from "../cron/run-history.js";
import type { CronRunLogEntry } from "../cron/run-log-types.js";
import { CRON_FAILURE_REPAIR_TIMEOUT_MS } from "../cron/service/failure-alerts.js";
import type { CronFailureRepairRequest } from "../cron/service/notification-intents.js";
import type { Logger } from "../cron/service/state.js";
import { cronStoreKey } from "../cron/store/key.js";
import { readCronRunRecords } from "../cron/store/read-only.js";
import type { CronJob, CronStoredJob } from "../cron/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { runWithGatewayDetachedWorkContinuation } from "../process/gateway-work-admission.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { isOperatorCommandCronJob } from "./server-methods/cron-caller-scope.js";

const REPAIR_RECENT_RUNS = 5;
const REPAIR_PAYLOAD_MAX_CHARS = 4_000;
const REPAIR_RUN_DETAIL_MAX_CHARS = 600;
const REPAIR_RUNS_MAX_CHARS = 4_000;

type CronFailureRepairOutcome = "completed" | "unavailable" | "failed";

/** The private, self-contained instructions the owner conversation's agent repairs from. */
export function buildCronFailureRepairBrief(params: {
  job: CronStoredJob;
  runs: readonly CronRunLogEntry[];
  consecutiveErrors: number;
}): string {
  const { job } = params;
  const payload = job.payload;
  const payloadText =
    payload.kind === "agentTurn"
      ? payload.message
      : payload.kind === "systemEvent"
        ? payload.text
        : payload.kind === "script"
          ? payload.script
          : "";
  const toolsAllow = "toolsAllow" in payload ? payload.toolsAllow : undefined;
  const runLines = params.runs.flatMap((run) => {
    const detail = (run.error ?? run.summary)?.trim();
    return [
      [
        `- ${new Date(run.runAtMs ?? run.ts).toISOString()} ${run.status ?? "unknown"}`,
        ...(run.durationMs !== undefined ? [`${Math.round(run.durationMs / 1000)}s`] : []),
        ...(run.errorReason ? [`cause ${run.errorReason}`] : []),
      ].join(", "),
      ...(detail ? [`  ${truncateUtf16Safe(detail, REPAIR_RUN_DETAIL_MAX_CHARS)}`] : []),
    ];
  });
  return [
    "Automation repair: private background turn started by the scheduler, not a user message.",
    `Automation "${job.name || job.id}" (id ${job.id}) failed ${params.consecutiveErrors} consecutive runs and reached its failure-alert threshold. No alert was sent; this turn decides what happens next.`,
    "",
    `Schedule: ${JSON.stringify(job.schedule)}. Target: ${job.sessionTarget}. Payload kind: ${payload.kind}.${
      "timeoutSeconds" in payload && payload.timeoutSeconds !== undefined
        ? ` Timeout: ${payload.timeoutSeconds}s.`
        : ""
    } toolsAllow: ${toolsAllow ? JSON.stringify(toolsAllow) : "unrestricted"}.`,
    wrapUntrustedPromptDataBlock({
      label: "Current payload",
      text: payloadText,
      maxChars: REPAIR_PAYLOAD_MAX_CHARS,
      truncationMarker: " [truncated]",
    }),
    wrapUntrustedPromptDataBlock({
      label: "Recent runs, newest first",
      text: runLines.join("\n") || "No recorded runs.",
      maxChars: REPAIR_RUNS_MAX_CHARS,
      truncationMarker: " [truncated]",
    }),
    "",
    "Diagnose the failure (inspect the workspace and the automation as needed), then do exactly one:",
    `1. Transient outage (provider, network, rate limit, or temporary upstream error; the job itself is fine): change nothing and reply exactly ${SILENT_REPLY_TOKEN}.`,
    `2. Fixable job logic (wrong prompt, broken or missing workspace helper script, wrong tool or arguments, too much work per run): fix it durably for the next run. Edit the workspace helper script and/or update this automation with the automations tool (update jobId "${job.id}": payload and trigger only, same payload kind, toolsAllow can only lose entries). Verify the fix, for example run it with runMode "force" and read its state with get. Then reply with one short sentence saying what you fixed, or ${SILENT_REPLY_TOKEN}.`,
    "3. Needs the user (expired or missing credentials, access only they can grant, or a decision only they can make): leave the automation unchanged and tell the user concisely what is wrong and what they need to do.",
    ...(job.runtimeAuthority
      ? [
          "Changing toolsAllow drops this automation's captured configured-MCP tool authority until its owner saves it again; avoid it unless the fix needs it.",
        ]
      : []),
    `Your final reply is posted to this conversation as-is; ${SILENT_REPLY_TOKEN} keeps it silent. If the automation keeps failing after this turn, the user gets the normal failure alert.`,
  ].join("\n");
}

/**
 * Starts the repair turn in the job's owner conversation with a host-minted grant that
 * can get, update, and run only this job. Missing owner conversations are `unavailable`.
 */
export async function runGatewayCronFailureRepair(params: {
  request: CronFailureRepairRequest & { job: CronStoredJob };
  getJob: (jobId: string) => CronJob | undefined;
  storePath: string;
  deps: CliDeps;
  resolveCronAgent: (requested?: string | null) => { agentId: string; cfg: OpenClawConfig };
  runSchedulerOwned: <T>(run: () => Promise<T>) => Promise<T>;
  log: Logger;
}): Promise<CronFailureRepairOutcome> {
  const { request } = params;
  const { job, ownerSessionKey } = request;
  const ownsJob = (candidate: CronJob | undefined) =>
    candidate !== undefined &&
    candidate.enabled !== false &&
    candidate.owner?.sessionKey?.trim() === ownerSessionKey &&
    !isOperatorCommandCronJob(candidate);
  if (!ownsJob(job)) {
    return "unavailable";
  }
  let agent: { agentId: string; cfg: OpenClawConfig };
  try {
    agent = params.resolveCronAgent(
      job.owner?.agentId?.trim() || resolveAgentIdFromSessionKey(ownerSessionKey),
    );
  } catch (err) {
    params.log.warn(
      { jobId: job.id, err: formatErrorMessage(err) },
      "cron: repair owner agent unavailable",
    );
    return "unavailable";
  }
  const ownerSession = await readSessionEntryInWorker(
    { agentId: agent.agentId, sessionKey: ownerSessionKey },
    () => {},
  );
  if (!ownerSession?.sessionId || ownerSession.archivedAt !== undefined) {
    return "unavailable";
  }
  const storeKey = cronStoreKey(params.storePath);
  const runs = projectCronRunHistoryPage(await readCronRunRecords(storeKey, job.id), {
    storeKey,
    jobId: job.id,
    limit: REPAIR_RECENT_RUNS,
  }).entries;
  const message = buildCronFailureRepairBrief({
    job,
    runs,
    consecutiveErrors: request.consecutiveErrors,
  });
  const nowMs = Date.now();
  const deadlineMs = nowMs + CRON_FAILURE_REPAIR_TIMEOUT_MS;
  // A detached `current` turn in the owner conversation: its final visible reply is
  // committed there, NO_REPLY stays silent. It inherits the failing job's owner and
  // restrict-only execution policy; toolsAllow covers workspace edits and the grant.
  const repairJob: CronStoredJob = {
    id: randomUUID(),
    agentId: agent.agentId,
    name: `Repair: ${job.name || job.id}`,
    enabled: true,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    schedule: { kind: "at", at: new Date(nowMs).toISOString() },
    sessionTarget: "current",
    sessionKey: ownerSessionKey,
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message,
      timeoutSeconds: Math.floor(CRON_FAILURE_REPAIR_TIMEOUT_MS / 1000),
      toolsAllow: ["*"],
    },
    ...(job.owner ? { owner: job.owner } : {}),
    ...(job.scheduledToolPolicy ? { scheduledToolPolicy: job.scheduledToolPolicy } : {}),
    ...(job.toolsAllowProvenance ? { toolsAllowProvenance: job.toolsAllowProvenance } : {}),
    ...(job.toolsAllowExecTarget ? { toolsAllowExecTarget: job.toolsAllowExecTarget } : {}),
    state: { nextRunAtMs: nowMs },
  };
  try {
    const result = await runWithGatewayDetachedWorkContinuation(
      () =>
        params.runSchedulerOwned(() =>
          runCronIsolatedAgentTurn({
            cfg: agent.cfg,
            deps: params.deps,
            job: repairJob,
            message,
            sessionKey: `cron:${repairJob.id}`,
            agentId: agent.agentId,
            lane: "cron",
            abortSignal: AbortSignal.timeout(CRON_FAILURE_REPAIR_TIMEOUT_MS + 60_000),
            cronManagement: {
              entitlement: { source: "failure-repair", jobId: job.id },
              isCurrent: () => Date.now() < deadlineMs && ownsJob(params.getJob(job.id)),
            },
          }),
        ),
      "cron:failure-repair",
    );
    if (result.status === "ok") {
      params.log.info(
        { jobId: job.id, repairRunSessionKey: result.sessionKey, delivered: result.delivered },
        "cron: failure repair turn completed",
      );
      return "completed";
    }
    params.log.warn(
      { jobId: job.id, status: result.status, error: result.error },
      "cron: failure repair turn did not complete",
    );
    return "failed";
  } catch (err) {
    params.log.warn(
      { jobId: job.id, err: formatErrorMessage(err) },
      "cron: failure repair turn failed",
    );
    return "failed";
  }
}
