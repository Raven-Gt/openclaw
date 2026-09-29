// Tests how an admitted interactive run continues a turn the stale watchdog dropped.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type * as AgentRunnerExecution from "./agent-runner-execution.js";
import { runReplyAgent } from "./agent-runner.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";
import {
  clearSessionQueues,
  enqueueFollowupRun,
  getFollowupQueueDepth,
  type FollowupRun,
  type QueueSettings,
} from "./queue.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { createReplyOperation, type ReplyOperation } from "./reply-run-registry.js";
import { expireStaleReplyOperation } from "./reply-run-registry.state.js";
import { testing as replyRunTesting } from "./reply-run-registry.test-support.js";
import { createMockTypingController } from "./test-helpers.js";

const mocks = vi.hoisted(() => ({
  executeAgentTurn: vi.fn(),
  drainedRuns: vi.fn(async (_run: FollowupRun) => {}),
}));
const executeAgentTurnMock = mocks.executeAgentTurn;
const drainedRuns = mocks.drainedRuns;

vi.mock("./agent-runner-memory.js", () => ({
  runSessionCompactionIfNeeded: async () => undefined,
  runMemoryFlushIfNeeded: async () => ({ sessionEntry: undefined, outcome: "skipped" }),
}));

vi.mock("./agent-runner-execution.js", async () => ({
  ...(await vi.importActual<typeof AgentRunnerExecution>("./agent-runner-execution.js")),
  executeAgentTurn: (...args: unknown[]) => mocks.executeAgentTurn(...args),
}));

vi.mock("./followup-runner.js", () => ({
  createFollowupRunner: () => mocks.drainedRuns,
}));

type StalledRun = {
  operation: ReplyOperation;
  run: Promise<unknown>;
  runState: ReplyOperationRunState;
};

const queueKey = "agent:main:telegram:direct:stalled";
const settings: QueueSettings = { mode: "followup", debounceMs: 0 };

function createStalledRun(options: { isHeartbeat?: boolean } = {}): StalledRun {
  const followupRun = createTestFollowupRun({
    sessionId: "stalled-session",
    sessionKey: queueKey,
    messageProvider: "telegram",
  });
  followupRun.images = [{ type: "image", data: "aW1n", mimeType: "image/png" }];
  followupRun.transcriptPrompt = "what is good at the hotel restaurant?";
  const operation = createReplyOperation({
    sessionKey: queueKey,
    sessionId: "stalled-session",
    resetTriggered: false,
  });
  operation.setPhase("running");
  const runState: ReplyOperationRunState = {};
  const run = runReplyAgent({
    commandBody: "what is good at the hotel restaurant?",
    followupRun,
    queueKey,
    resolvedQueue: settings,
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    replyOperation: operation,
    opts: {
      [REPLY_OPERATION_RUN_STATE]: runState,
      ...(options.isHeartbeat ? { isHeartbeat: true } : {}),
    },
    typing: createMockTypingController(),
    sessionCtx: {
      Provider: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "12345",
      ChatType: "direct",
      MessageSid: "msg-stalled",
    } as unknown as TemplateContext,
    defaultModel: "anthropic/claude",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
  });
  return { operation, run, runState };
}

async function stallBeforeOutput(stalled: StalledRun) {
  await vi.waitFor(() => expect(executeAgentTurnMock).toHaveBeenCalledOnce());
  expect(expireStaleReplyOperation(stalled.operation, "stuck_recovery")).toBe(false);
}

async function settleStalledOwner(stalled: StalledRun) {
  await stalled.run;
  stalled.operation.complete();
}

function createQueuedRequest(): FollowupRun {
  const queued = createTestFollowupRun({
    sessionId: "stalled-session",
    sessionKey: queueKey,
    messageProvider: "telegram",
    terminalReplyExpectation: "required",
  });
  queued.prompt = "answer already";
  queued.messageId = "msg-followup";
  return queued;
}

describe("runReplyAgent stalled turn continuation", () => {
  beforeEach(() => {
    replyRunTesting.resetReplyRunRegistry();
    clearSessionQueues([queueKey]);
    drainedRuns.mockClear();
    executeAgentTurnMock
      .mockReset()
      .mockImplementation(async (params: { replyOperation: { abortSignal: AbortSignal } }) => {
        await new Promise<void>((resolve) => {
          params.replyOperation.abortSignal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        return { runId: "stalled-run", outcome: { kind: "aborted", reason: "user" } };
      });
  });

  afterEach(() => {
    clearSessionQueues([queueKey]);
    replyRunTesting.resetReplyRunRegistry();
  });

  it("queues exactly one transcript-only recovery run when nothing else is queued", async () => {
    const stalled = createStalledRun();
    await stallBeforeOutput(stalled);

    expect(stalled.runState.continueStalledTurn?.()).toBe(true);
    expect(getFollowupQueueDepth(queueKey)).toBe(1);
    // The lane stays dormant until the stalled owner releases the session.
    expect(drainedRuns).not.toHaveBeenCalled();

    await settleStalledOwner(stalled);
    await vi.waitFor(() => expect(drainedRuns).toHaveBeenCalledOnce());
    const recovery = drainedRuns.mock.calls[0]?.[0];
    expect(recovery?.stalledTurnRecovery).toBe(true);
    expect(recovery?.prompt).toContain("previous turn stopped making progress");
    expect(recovery?.prompt).toContain("Answer the user's outstanding request now");
    // Replay safety: the inbound request is not re-sent or re-persisted.
    expect(recovery?.run.suppressNextUserMessagePersistence).toBe(true);
    expect(recovery?.transcriptPrompt).toBeUndefined();
    expect(recovery?.images).toBeUndefined();
    expect(recovery?.abortSignal).toBeUndefined();
    expect(recovery?.run.sessionKey).toBe(queueKey);
    expect(getFollowupQueueDepth(queueKey)).toBe(0);
  });

  it("gives an already-queued user request the interruption guidance instead", async () => {
    const stalled = createStalledRun();
    const queued = createQueuedRequest();
    expect(enqueueFollowupRun(queueKey, queued, settings, "message-id", drainedRuns, false)).toBe(
      true,
    );
    await stallBeforeOutput(stalled);

    expect(stalled.runState.continueStalledTurn?.()).toBe(true);
    expect(getFollowupQueueDepth(queueKey)).toBe(1);
    expect(queued.prompt).toBe("answer already");
    expect(queued.currentInboundContext?.fragments).toContainEqual({
      kind: "runtime-instruction",
      text: expect.stringContaining("previous turn stopped making progress"),
    });

    await settleStalledOwner(stalled);
    await vi.waitFor(() => expect(drainedRuns).toHaveBeenCalledOnce());
    expect(drainedRuns.mock.calls[0]?.[0]).toBe(queued);
    expect(drainedRuns.mock.calls[0]?.[0].stalledTurnRecovery).toBeUndefined();
  });

  it("does not arm a continuation for heartbeat turns", async () => {
    const stalled = createStalledRun({ isHeartbeat: true });
    await stallBeforeOutput(stalled);

    expect(stalled.runState.continueStalledTurn).toBeUndefined();

    await settleStalledOwner(stalled);
    expect(getFollowupQueueDepth(queueKey)).toBe(0);
  });
});
