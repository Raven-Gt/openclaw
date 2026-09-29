import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";
import { buildAssistantEvents, buildFailedResponseEvents } from "./mock-openai-events.js";
import { extractToolOutputCallId, parseToolOutputJson } from "./mock-openai-input.js";
import { findToolCallByCallId } from "./mock-openai-tool-routing.js";

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

/**
 * Scripts the cron failure-repair QA flow: the job's broken step fails its turn, and the
 * scheduler's repair brief updates the job to a working step, force-runs it, then reports.
 */
export function planCronFailureRepairTurn(params: {
  prompt: string;
  input: ResponsesInputItem[];
  rawToolOutput: string;
  buildToolCall: (name: string, args: Record<string, unknown>) => StreamEvent[];
}): StreamEvent[] | null {
  const { prompt } = params;
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
  const completedToolCall = findToolCallByCallId(
    params.input,
    extractToolOutputCallId(params.input),
  );
  const completedAction = readAutomationsAction(completedToolCall);
  if (completedAction === undefined) {
    return params.buildToolCall("automations", {
      action: "update",
      jobId,
      job: { payload: { kind: "agentTurn", message: QA_CRON_REPAIR_FIXED_MESSAGE } },
    });
  }
  // Proceed only on proof of success: the updated job echoes its new message, and a
  // started run acknowledges ok. Tool rejections are plain text and must stop here.
  const succeeded =
    completedAction === "update"
      ? params.rawToolOutput.includes(QA_CRON_REPAIR_FIXED_MESSAGE)
      : parseToolOutputJson(params.rawToolOutput)?.ok === true;
  if (!succeeded) {
    return buildAssistantEvents(
      `BUG-CRON-REPAIR-${completedAction.toUpperCase()}-FAILED ${params.rawToolOutput}`,
    );
  }
  if (completedAction === "update") {
    return params.buildToolCall("automations", { action: "run", jobId, runMode: "force" });
  }
  return buildAssistantEvents(
    `Fixed the broken automation step and started a verification run. ${QA_CRON_REPAIR_FIXED_MARKER}`,
  );
}
