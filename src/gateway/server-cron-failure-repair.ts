/** Runs one owner-conversation repair turn for an automation past its failure-alert threshold. */
import { randomUUID } from "node:crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { wrapUntrustedPromptDataBlock } from "../agents/sanitize-for-prompt.js";
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { CliDeps } from "../cli/deps.types.js";
import { readSessionEntryInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runCronIsolatedAgentTurn } from "../cron/isolated-agent.js";
import { projectCronRunHistoryPage } from "../cron/run-history.js";
import type { CronRunLogEntry } from "../cron/run-log-types.js";
import {
  CRON_FAILURE_REPAIR_TIMEOUT_MS,
  isCronFailureRepairEligible,
} from "../cron/service/failure-alerts.js";
import type { CronFailureRepairRequest } from "../cron/service/notification-intents.js";
import type { Logger } from "../cron/service/state.js";
import { cronStoreKey } from "../cron/store/key.js";
import { readCronRunRecords } from "../cron/store/read-only.js";
import type { CronJob, CronStoredJob } from "../cron/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { runWithGatewayDetachedWorkContinuation } from "../process/gateway-work-admission.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";

const REPAIR_RECENT_RUNS = 5;
const REPAIR_PAYLOAD_MAX_CHARS = 4_000;
const REPAIR_RUN_DETAIL_MAX_CHARS = 600;
const REPAIR_RUNS_MAX_CHARS = 4_000;

type CronFailureRepairOutcome = "completed" | "unavailable" | "failed";

/**
 * The repair turn keeps the failing job's own effective tool cap (and its scheduled policy,
 * exec pin, provenance, and runtime authority) plus only the automations tool, which the
 * host grant limits to get/update/run of this job. Returns undefined for an unrestricted cap.
 */
function resolveRepairTurnToolsAllow(job: CronStoredJob): string[] | undefined {
  const cap = "toolsAllow" in job.payload ? job.payload.toolsAllow : undefined;
  return cap === undefined || cap.includes("*") ? cap : [...cap, AUTOMATIONS_TOOL_NAME];
}

/** Workspace edits need a file or shell tool; without one the repair can change only job text. */
const WORKSPACE_EDIT_TOOLS = new Set([
  "*",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "group:fs",
  "group:runtime",
]);

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
  const canEditWorkspace =
    toolsAllow === undefined || toolsAllow.some((tool) => WORKSPACE_EDIT_TOOLS.has(tool));
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
    `2. Fixable job logic (wrong prompt, broken or missing workspace helper script, wrong tool or arguments, too much work per run): fix it durably for the next run. ${
      canEditWorkspace
        ? "Edit the workspace helper script and/or update"
        : "This turn has the automation's own tools, which cannot edit workspace files, so you can only update"
    } this automation's text with the automations tool (update jobId "${job.id}" with only payload.message for agentTurn, payload.script for script payloads, or trigger.script; tools, schedule, and delivery stay as they are).${
      canEditWorkspace
        ? ""
        : " If the fix needs a helper script or other workspace change, treat it as case 3 and tell the user exactly what to change."
    } Verify the fix, for example run it with runMode "force" and read its state with get. Then reply with one short sentence saying what you fixed, or ${SILENT_REPLY_TOKEN}.`,
    "3. Needs the user (expired or missing credentials, access only they can grant, a tool the job is not allowed to use, or a decision only they can make): leave the automation unchanged and tell the user concisely what is wrong and what they need to do.",
    `Your final reply is posted to this conversation as-is; ${SILENT_REPLY_TOKEN} keeps it silent. If the automation keeps failing after this turn, the user gets the normal failure alert.`,
  ].join("\n");
}

/**
 * Starts the repair turn in the job's owner conversation with a host-minted grant that
 * can get, update, and run only this job. Missing owner conversations, and a job that is no
 * longer enabled, owned, eligible, or on the exact incident by admission, are `unavailable`.
 */
export async function runGatewayCronFailureRepair(params: {
  request: CronFailureRepairRequest & { job: CronStoredJob };
  getJob: (jobId: string) => CronStoredJob | undefined;
  storePath: string;
  deps: CliDeps;
  resolveCronAgent: (requested?: string | null) => { agentId: string; cfg: OpenClawConfig };
  runSchedulerOwned: <T>(run: () => Promise<T>) => Promise<T>;
  log: Logger;
}): Promise<CronFailureRepairOutcome> {
  const { request } = params;
  const { ownerSessionKey } = request;
  const ownsJob = (candidate: CronJob | undefined): candidate is CronJob =>
    candidate !== undefined &&
    candidate.enabled !== false &&
    !candidate.state.autoDisabled &&
    candidate.owner?.sessionKey?.trim() === ownerSessionKey &&
    isCronFailureRepairEligible(candidate);
  // The dispatch-time snapshot can predate the committed incident; the request carries it.
  const { incidentSignature, repairAtMs } = request;
  if (!ownsJob(request.job)) {
    return "unavailable";
  }
  // The repair lives only while the exact incident that started it is still open,
  // unescalated, and owned: a success that clears it, a new incident, or an alert ends it.
  const repairsIncident = (candidate: CronStoredJob | undefined): candidate is CronStoredJob => {
    const live = candidate?.state.failureAlertIncident;
    return (
      ownsJob(candidate) &&
      live !== undefined &&
      live.signature === incidentSignature &&
      live.repair?.atMs === repairAtMs &&
      live.repair.alerted !== true
    );
  };
  let agent: { agentId: string; cfg: OpenClawConfig };
  try {
    agent = params.resolveCronAgent(
      request.job.owner?.agentId?.trim() || resolveAgentIdFromSessionKey(ownerSessionKey),
    );
  } catch (err) {
    params.log.warn(
      { jobId: request.job.id, err: formatErrorMessage(err) },
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
  const runs = projectCronRunHistoryPage(await readCronRunRecords(storeKey, request.job.id), {
    storeKey,
    jobId: request.job.id,
    limit: REPAIR_RECENT_RUNS,
  }).entries;
  const jobId = request.job.id;
  try {
    const result = await runWithGatewayDetachedWorkContinuation(
      () =>
        params.runSchedulerOwned(async () => {
          // Admission: the job may have been disabled, re-owned, re-capped, or resolved while
          // the reads above or scheduler admission awaited. The turn's whole envelope (tool
          // cap, policy, authority) comes from the live job now, never the dispatch-time clone.
          const liveJob = params.getJob(jobId);
          if (!repairsIncident(liveJob)) {
            return undefined;
          }
          const job = structuredClone(liveJob);
          const message = buildCronFailureRepairBrief({
            job,
            runs,
            consecutiveErrors: request.consecutiveErrors,
          });
          const nowMs = Date.now();
          const deadlineMs = nowMs + CRON_FAILURE_REPAIR_TIMEOUT_MS;
          // A detached `current` turn in the owner conversation: its final visible reply is
          // committed there, NO_REPLY stays silent. It inherits the failing job's owner and
          // execution envelope: its tool cap plus the job-scoped automations grant.
          const repairToolsAllow = resolveRepairTurnToolsAllow(job);
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
              ...(repairToolsAllow ? { toolsAllow: repairToolsAllow } : {}),
            },
            ...(job.owner ? { owner: job.owner } : {}),
            ...(job.scheduledToolPolicy ? { scheduledToolPolicy: job.scheduledToolPolicy } : {}),
            ...(job.toolsAllowProvenance ? { toolsAllowProvenance: job.toolsAllowProvenance } : {}),
            ...(job.toolsAllowExecTarget ? { toolsAllowExecTarget: job.toolsAllowExecTarget } : {}),
            ...(job.toolsAllowExecTargetRequirement
              ? { toolsAllowExecTargetRequirement: job.toolsAllowExecTargetRequirement }
              : {}),
            ...(job.runtimeAuthority ? { runtimeAuthority: job.runtimeAuthority } : {}),
            ...(job.runtimeAuthorityRecoveryRequired
              ? { runtimeAuthorityRecoveryRequired: true }
              : {}),
            state: { nextRunAtMs: nowMs },
          };
          return await runCronIsolatedAgentTurn({
            cfg: agent.cfg,
            deps: params.deps,
            job: repairJob,
            message,
            sessionKey: `cron:${repairJob.id}`,
            agentId: agent.agentId,
            lane: "cron",
            abortSignal: AbortSignal.timeout(CRON_FAILURE_REPAIR_TIMEOUT_MS + 60_000),
            cronManagement: {
              entitlement: {
                source: "failure-repair",
                jobId,
                isCurrent: () => repairsIncident(params.getJob(jobId)),
              },
              isCurrent: () => Date.now() < deadlineMs,
            },
          });
        }),
      "cron:failure-repair",
    );
    if (!result) {
      params.log.info({ jobId }, "cron: failure repair no longer applies at admission");
      return "unavailable";
    }
    // The repair's outcome must reach the owner conversation (or be intentionally silent);
    // an undelivered result leaves the user uninformed, so the alert goes out instead.
    if (
      result.status === "ok" &&
      (result.delivered === true || result.deliverySuppressionReason === "silent")
    ) {
      params.log.info(
        { jobId, repairRunSessionKey: result.sessionKey, delivered: result.delivered },
        "cron: failure repair turn completed",
      );
      return "completed";
    }
    params.log.warn(
      {
        jobId,
        status: result.status,
        error: result.error,
        delivered: result.delivered,
        deliveryError: result.deliveryError,
      },
      "cron: failure repair turn did not complete",
    );
    return "failed";
  } catch (err) {
    params.log.warn({ jobId, err: formatErrorMessage(err) }, "cron: failure repair turn failed");
    return "failed";
  }
}
