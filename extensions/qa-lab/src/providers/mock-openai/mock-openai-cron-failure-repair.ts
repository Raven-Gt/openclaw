import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";
import { buildAssistantEvents, buildFailedResponseEvents } from "./mock-openai-events.js";
import { parseToolOutputJson } from "./mock-openai-input.js";

const QA_CRON_REPAIR_PROMPT_RE = /Cron failure repair QA check/i;
const QA_CRON_REPAIR_BROKEN_RE = /Cron failure repair QA check: broken step/i;
const QA_CRON_REPAIR_BRIEF_RE =
  /Automation repair: private background turn started by the scheduler[\s\S]*?\(id ([^)\s]+)\) failed \d+ consecutive runs/;
const QA_CRON_REPAIR_OWNER_MARKER = "QA-CRON-REPAIR-OWNER-READY";
const QA_CRON_REPAIR_JOB_MARKER = "QA-CRON-REPAIR-JOB-OK";
const QA_CRON_REPAIR_FIXED_MARKER = "QA-CRON-REPAIR-FIXED";
const QA_CRON_REPAIR_FIXED_MESSAGE = `Cron failure repair QA check: fixed step. Reply exactly \`${QA_CRON_REPAIR_JOB_MARKER}\`.`;

function readAutomationsAction(toolCall: ResponsesInputItem | undefined): string | undefined {
  if (typeof toolCall?.arguments !== "string") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCall.arguments);
  } catch {
    return undefined;
  }
  const args =
    toolCall.name === "tool_call" && isRecord(parsed) && parsed.id === "automations"
      ? parsed.args
      : toolCall.name === "automations"
        ? parsed
        : undefined;
  return isRecord(args) && typeof args.action === "string" ? args.action : undefined;
}

const QA_CRON_REPAIR_FENCED_MARKER = "QA-CRON-REPAIR-FENCED";
const QA_CRON_REPAIR_TAMPERED_MESSAGE =
  "Cron failure repair QA check: tampered step after the fix.";
const QA_CRON_REPAIR_INACTIVE_TEXT = "automation repair is no longer active";
const QA_CRON_REPAIR_MAX_POLLS = 40;
const QA_CRON_REPAIR_CAP_RE = /Cron failure repair QA check: broken step \(cap narrowing\)/i;
const QA_CRON_REPAIR_CAP_MARKER_FILE = "cron-repair-cap-marker.txt";
const QA_CRON_REPAIR_CAP_PAUSE_MS = 5_000;

/**
 * Scripts the narrowed-cap flow: the repair's first tool call is a workspace write, held long
 * enough for the operator to remove `write` from the job's cap. The Gateway must abort the
 * turn before that write runs; reaching the write's continuation is the bug marker.
 */
export function planCronFailureRepairCapTurn(params: {
  prompt: string;
  input: ResponsesInputItem[];
  buildToolCall: (name: string, args: Record<string, unknown>) => StreamEvent[];
}): { events: StreamEvent[]; pauseMs?: number } | null {
  if (!QA_CRON_REPAIR_CAP_RE.test(params.prompt) || !QA_CRON_REPAIR_BRIEF_RE.test(params.prompt)) {
    return null;
  }
  const wrote = params.input.some(
    (item) =>
      item.name === "write" ||
      (item.name === "tool_call" &&
        typeof item.arguments === "string" &&
        /"id"\s*:\s*"write"/u.test(item.arguments)),
  );
  if (wrote) {
    return { events: buildAssistantEvents("BUG-CRON-REPAIR-CAP-WROTE") };
  }
  return {
    events: params.buildToolCall("write", {
      path: QA_CRON_REPAIR_CAP_MARKER_FILE,
      content: "Written by a repair whose tool cap was narrowed.\n",
    }),
    pauseMs: QA_CRON_REPAIR_CAP_PAUSE_MS,
  };
}

/**
 * Scripts the cron failure-repair QA flow: the job's broken step fails its turn, and the
 * scheduler's repair brief updates the job to a working step and force-runs it. It then polls
 * with get until the verification run resolves the incident, and proves the grant is fenced:
 * a further update and run from the same turn must be rejected before it reports.
 */
export function planCronFailureRepairTurn(params: {
  prompt: string;
  input: ResponsesInputItem[];
  rawToolOutput: string;
  buildToolCall: (name: string, args: Record<string, unknown>) => StreamEvent[];
}): StreamEvent[] | null {
  const { prompt, rawToolOutput } = params;
  if (!QA_CRON_REPAIR_PROMPT_RE.test(prompt)) {
    return null;
  }
  const jobId = QA_CRON_REPAIR_BRIEF_RE.exec(prompt)?.[1];
  if (!jobId) {
    if (QA_CRON_REPAIR_BROKEN_RE.test(prompt)) {
      return buildFailedResponseEvents();
    }
    return buildAssistantEvents(
      prompt.includes(QA_CRON_REPAIR_OWNER_MARKER)
        ? QA_CRON_REPAIR_OWNER_MARKER
        : QA_CRON_REPAIR_JOB_MARKER,
    );
  }
  const actions = params.input.flatMap((item) => readAutomationsAction(item) ?? []);
  const last = actions.at(-1);
  const fail = () =>
    buildAssistantEvents(`BUG-CRON-REPAIR-${actions.join("-").toUpperCase()} ${rawToolOutput}`);
  const rejected = rawToolOutput.toLowerCase().includes(QA_CRON_REPAIR_INACTIVE_TEXT);
  const fenced = actions.length > 2 && actions.at(-2) !== "run" && last === "update";
  if (last === undefined) {
    return params.buildToolCall("automations", {
      action: "update",
      jobId,
      job: { payload: { kind: "agentTurn", message: QA_CRON_REPAIR_FIXED_MESSAGE } },
    });
  }
  // The fix: the updated job echoes its new message, and the started run acknowledges ok.
  if (actions.length === 1) {
    return rawToolOutput.includes(QA_CRON_REPAIR_FIXED_MESSAGE)
      ? params.buildToolCall("automations", { action: "run", jobId, runMode: "force" })
      : fail();
  }
  if (actions.length === 2) {
    return parseToolOutputJson(rawToolOutput)?.ok === true
      ? params.buildToolCall("automations", { action: "get", jobId })
      : fail();
  }
  // Wait for the verification run to resolve the incident, which ends the grant.
  if (last === "get") {
    if (rejected) {
      return params.buildToolCall("automations", {
        action: "update",
        jobId,
        job: { payload: { kind: "agentTurn", message: QA_CRON_REPAIR_TAMPERED_MESSAGE } },
      });
    }
    return actions.length < QA_CRON_REPAIR_MAX_POLLS
      ? params.buildToolCall("automations", { action: "get", jobId })
      : fail();
  }
  if (fenced) {
    return rejected
      ? params.buildToolCall("automations", { action: "run", jobId, runMode: "force" })
      : fail();
  }
  if (last === "run" && actions.at(-2) === "update" && actions.length > 3 && rejected) {
    return buildAssistantEvents(
      `Fixed the broken automation step and verified it. ${QA_CRON_REPAIR_FIXED_MARKER} ${QA_CRON_REPAIR_FENCED_MARKER}`,
    );
  }
  return fail();
}
