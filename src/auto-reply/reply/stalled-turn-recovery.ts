import { appendCurrentInboundContext } from "../../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import { formatSystemTurnPrompt } from "../../sessions/system-turn-prompt.js";
import type { ReplyPayload } from "../types.js";
import type { FollowupRun } from "./queue/types.js";
import type { ReplyOperation } from "./reply-run-registry.js";

const STALLED_TURN_NOTICE_TEXT =
  "⚠️ This turn was interrupted because it stopped making progress. Please try again.";
const STALLED_TURN_RECOVERY_MARKER = "stalled-turn-recovery";
const STALLED_TURN_GUIDANCE =
  "Your previous turn stopped making progress and was stopped before you replied. " +
  "Answer the user's outstanding request now from what the transcript already contains. " +
  "Keep further tool use to a minimum, do not repeat actions that already ran, and briefly " +
  "say what you could not verify.";

/** A stale watchdog expired this operation before it produced output: the user saw nothing. */
export function isReplyOperationStalledBeforeOutput(
  operation: ReplyOperation | undefined,
): boolean {
  return (
    operation?.result?.kind === "failed" &&
    operation.result.code === "run_stalled" &&
    (operation.staleExpiryReason === "no_activity" ||
      operation.staleExpiryReason === "stuck_recovery")
  );
}

/** Last-resort feedback once no continuation can answer a stalled turn. */
export function buildStalledTurnNoticePayload(): ReplyPayload {
  return { text: STALLED_TURN_NOTICE_TEXT, isError: true };
}

/** Tells an already-queued user request that the turn before it stalled unanswered. */
export function appendStalledTurnGuidance(queued: FollowupRun): void {
  queued.currentInboundContext = appendCurrentInboundContext(queued.currentInboundContext, [
    { kind: "runtime-instruction", text: STALLED_TURN_GUIDANCE },
  ]);
}

/** Builds the one recovery run that answers a stalled turn over its persisted transcript. */
export function buildStalledTurnRecoveryRun(base: FollowupRun): FollowupRun {
  return {
    ...base,
    prompt: formatSystemTurnPrompt(STALLED_TURN_GUIDANCE),
    summaryLine: STALLED_TURN_RECOVERY_MARKER,
    stalledTurnRecovery: true,
    disableCollectBatching: true,
    enqueuedAt: Date.now(),
    // The inbound request, its media, and its runtime context are already in the
    // transcript; this internal system turn persists no user message of its own.
    transcriptPrompt: undefined,
    userTurnTranscriptRecorder: undefined,
    currentInboundContext: undefined,
    images: undefined,
    imageOrder: undefined,
    media: undefined,
    // The stalled turn's signal, adoption lifecycle, and receipts belong to the
    // aborted dispatch; sharing them would cancel or settle this run with it.
    abortSignal: undefined,
    turnAdoptionLifecycle: undefined,
    replyOperationRunStates: undefined,
    onQueueDisposition: undefined,
    run: { ...base.run, suppressNextUserMessagePersistence: true },
  };
}
