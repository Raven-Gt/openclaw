import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { RUN_STALE_TAKEOVER_MS } from "../../logging/diagnostic-run-activity.js";
import type { ReplyPayload } from "../types.js";
import {
  createDispatcher,
  mocks,
  noAbortResult,
  resetPluginTtsAndThreadMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import type { DispatchFromConfigParams } from "./dispatch-from-config.types.js";
import { resolveReplyOperationRunState } from "./reply-operation-run-state.js";
import type { ReplyOperationStaleReason } from "./reply-run-finalization-lease.js";
import { buildTestCtx } from "./test-ctx.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let createReplyOperation: typeof import("./reply-run-registry.js").createReplyOperation;
let expireStaleReplyOperation: typeof import("./reply-run-registry.state.js").expireStaleReplyOperation;
let REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS: typeof import("./reply-run-registry.contracts.js").REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS;
let replyRunRegistry: typeof import("./reply-run-registry.js").replyRunRegistry;
let replyRunTesting: typeof import("./reply-run-registry.test-support.js").testing;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;

const sessionKey = "agent:main:telegram:direct:1";

function setNoAbort() {
  mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
}

function createVisibleDispatchParams(
  replyResolver: NonNullable<DispatchFromConfigParams["replyResolver"]>,
) {
  return {
    ctx: buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "user:1",
      ChatType: "direct",
      SessionKey: sessionKey,
      MessageThreadId: "501.000",
      BodyForAgent: "second telegram direct turn",
    }),
    cfg: {} as OpenClawConfig,
    dispatcher: createDispatcher(),
    replyResolver,
  };
}

describe("dispatchReplyFromConfig stale visible admission recovery", () => {
  beforeAll(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
    ({ createReplyOperation, replyRunRegistry } = await import("./reply-run-registry.js"));
    ({ expireStaleReplyOperation } = await import("./reply-run-registry.state.js"));
    ({ REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS } = await import("./reply-run-registry.contracts.js"));
    ({ testing: replyRunTesting } = await import("./reply-run-registry.test-support.js"));
    ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
  });

  beforeEach(() => {
    replyRunTesting.resetReplyRunRegistry();
    resetInboundDedupe();
    resetPluginTtsAndThreadMocks();
    mocks.routeReply.mockReset();
    mocks.routeReply.mockResolvedValue({ ok: true, delivered: true, messageId: "mock" });
    mocks.tryFastAbortFromMessage.mockReset();
    setNoAbort();
  });

  afterEach(() => {
    vi.useRealTimers();
    replyRunTesting.resetReplyRunRegistry();
    resetInboundDedupe();
  });

  it("waits for fresh visible reply work without invoking diagnostic recovery", async () => {
    vi.useFakeTimers();
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    activeOperation.abortSignal.addEventListener("abort", () => activeOperation.complete(), {
      once: true,
    });
    const replyResolver = vi.fn(async () => ({ text: "telegram reply" }) satisfies ReplyPayload);
    const dispatchParams = createVisibleDispatchParams(replyResolver);
    let settled = false;

    const resultPromise = dispatchReplyFromConfig(dispatchParams).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(120_000);

    expect(settled).toBe(false);
    expect(replyResolver).not.toHaveBeenCalled();

    activeOperation.complete();
    const result = await resultPromise;

    expect(result).toMatchObject({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatchParams.dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("reclaims stale pre-backend work after bounded terminal settlement", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    const replyResolver = vi.fn(async () => ({ text: "telegram reply" }) satisfies ReplyPayload);
    const dispatchParams = createVisibleDispatchParams(replyResolver);
    vi.setSystemTime(startedAt + RUN_STALE_TAKEOVER_MS + 1);

    const resultPromise = dispatchReplyFromConfig(dispatchParams);
    await vi.waitFor(() => {
      expect(activeOperation.result).toEqual({ kind: "failed", code: "run_stalled" });
    });
    expect(replyRunRegistry.get(sessionKey)).toBe(activeOperation);

    await vi.advanceTimersByTimeAsync(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS);
    const result = await resultPromise;

    expect(activeOperation.result).toEqual({ kind: "failed", code: "run_stalled" });
    expect(result).toMatchObject({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatchParams.dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  function createStallingDispatchParams(continueStalledTurn?: () => boolean) {
    let resolverStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      resolverStarted = resolve;
    });
    const dispatchParams = createVisibleDispatchParams(async (_ctx, options) => {
      const runState = resolveReplyOperationRunState(options);
      if (runState && continueStalledTurn) {
        // The admitted run owner arms this before model work starts.
        runState.continueStalledTurn = continueStalledTurn;
      }
      resolverStarted();
      await new Promise<void>((resolve) => {
        options?.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      const error = new Error("reply expired");
      error.name = "AbortError";
      throw error;
    });
    return { dispatchParams, started };
  }

  async function stallActiveReply(reason: ReplyOperationStaleReason) {
    const operation = replyRunRegistry.get(sessionKey);
    expect(operation).toBeDefined();
    expect(expireStaleReplyOperation(operation!, reason)).toBe(false);
  }

  it.each(["no_activity", "stuck_recovery"] as const)(
    "sends the stall notice when %s expires a reply nothing can continue",
    async (reason) => {
      const { dispatchParams, started } = createStallingDispatchParams();

      const dispatchPromise = dispatchReplyFromConfig(dispatchParams);
      await started;
      await stallActiveReply(reason);

      await expect(dispatchPromise).resolves.toMatchObject({ queuedFinal: true });
      expect(dispatchParams.dispatcher.sendFinalReply).toHaveBeenCalledWith({
        text: "⚠️ This turn was interrupted because it stopped making progress. Please try again.",
        isError: true,
      });
    },
  );

  it.each(["no_activity", "stuck_recovery"] as const)(
    "lets the session lane answer instead of the notice when %s expires the reply",
    async (reason) => {
      const continueStalledTurn = vi.fn(() => true);
      const { dispatchParams, started } = createStallingDispatchParams(continueStalledTurn);

      const dispatchPromise = dispatchReplyFromConfig(dispatchParams);
      await started;
      await stallActiveReply(reason);

      await expect(dispatchPromise).resolves.toMatchObject({ queuedFinal: false });
      expect(continueStalledTurn).toHaveBeenCalledOnce();
      expect(dispatchParams.dispatcher.sendFinalReply).not.toHaveBeenCalled();
    },
  );

  it("falls back to the stall notice when no continuation could be arranged", async () => {
    const continueStalledTurn = vi.fn(() => false);
    const { dispatchParams, started } = createStallingDispatchParams(continueStalledTurn);

    const dispatchPromise = dispatchReplyFromConfig(dispatchParams);
    await started;
    await stallActiveReply("stuck_recovery");

    await expect(dispatchPromise).resolves.toMatchObject({ queuedFinal: true });
    expect(continueStalledTurn).toHaveBeenCalledOnce();
    expect(dispatchParams.dispatcher.sendFinalReply).toHaveBeenCalledOnce();
  });

  it("neither continues nor notifies when finalization stalls after output", async () => {
    const continueStalledTurn = vi.fn(() => true);
    const { dispatchParams, started } = createStallingDispatchParams(continueStalledTurn);

    const dispatchPromise = dispatchReplyFromConfig(dispatchParams);
    await started;
    await stallActiveReply("finalization_stalled");

    await expect(dispatchPromise).resolves.toMatchObject({ queuedFinal: false });
    expect(continueStalledTurn).not.toHaveBeenCalled();
    expect(dispatchParams.dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });
});
