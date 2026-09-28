/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSteerResult } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  input,
  makeChatPageHost,
  sessionId,
  sessionKey,
} from "./chat-pending-inputs.test-support.ts";
import { applyChatPendingInputs, getChatPendingInputs } from "./chat-pending-inputs.ts";

const queued = { ...input, state: "queued" as const, queued: true as const };
const pendingInputs = { items: [queued], total: 1, queuedCount: 1 };
const rowId = "pending-input:" + input.id;

function createHost(steer: () => unknown = () => ({ status: "accepted", runId: input.runId })) {
  const host = makeChatPageHost({
    sessionKey,
    currentSessionId: sessionId,
    requestHandlers: {
      "chat.steer": steer,
      "chat.history": { sessionId, messages: [], pendingInputs },
    },
  });
  applyChatPendingInputs(host, pendingInputs);
  return host;
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Gateway-queued input steering", () => {
  it("targets admitted input by exact identity without copying its text or attachments", async () => {
    const host = createHost();
    applyChatPendingInputs(host, {
      ...pendingInputs,
      items: [
        {
          ...queued,
          message: {
            role: "user",
            content: "Display-only body",
            media: [{ url: "/media/source.png", contentType: "image/png" }],
          },
        },
      ],
    });
    await host.steerQueuedChatMessage(rowId);
    expect(host.request).toHaveBeenCalledWith("chat.steer", {
      sessionKey,
      sessionId,
      agentId: "main",
      runId: input.runId,
    });
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
    expect(host.chatQueue).toEqual([]);
    expect(getChatPendingInputs(host)?.queuedInputs).toHaveLength(1);
    expect(getChatPendingInputs(host)?.steeringRunIds.size).toBe(0);
  });

  it("coalesces duplicate clicks and retains the row until authoritative consumption", async () => {
    const response = createDeferred<ChatSteerResult>();
    const host = createHost(() => response.promise);
    const first = host.steerQueuedChatMessage(rowId);
    const second = host.steerQueuedChatMessage(rowId);
    expect(getChatPendingInputs(host)?.steeringRunIds.has(input.runId!)).toBe(true);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.steer")).toHaveLength(1);
    expect(getChatPendingInputs(host)?.queuedInputs).toHaveLength(1);
    response.resolve({ status: "accepted" });
    await Promise.all([first, second]);
    expect(getChatPendingInputs(host)?.queuedInputs).toHaveLength(1);
    applyChatPendingInputs(host, { items: [], total: 0, queuedCount: 0 });
    expect(getChatPendingInputs(host)?.queuedInputs).toHaveLength(0);
  });

  it("keeps failed steering queued and shows the current failure", async () => {
    const host = createHost(() => {
      throw new Error("The active run cannot accept this input; it remains queued.");
    });
    await host.steerQueuedChatMessage(rowId);
    expect(host.chatError).toContain("it remains queued");
    expect(host.lastError).toBe(host.chatError);
    expect(getChatPendingInputs(host)?.queuedInputs).toHaveLength(1);
    expect(getChatPendingInputs(host)?.steeringRunIds.size).toBe(0);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
  });

  it.each(["session", "incarnation", "agent", "connection", "epoch"] as const)(
    "does not publish a late control response into a changed %s",
    async (change) => {
      const response = createDeferred<ChatSteerResult>();
      const host = createHost(() => response.promise);
      if (change === "agent") {
        host.sessionKey = "global";
        host.assistantAgentId = "main";
        applyChatPendingInputs(host, pendingInputs);
      }
      const steering = host.steerQueuedChatMessage(rowId);
      if (change === "session") {
        host.sessionKey = "agent:main:other";
      }
      if (change === "incarnation") {
        host.currentSessionId = "replacement-session";
      }
      if (change === "agent") {
        host.assistantAgentId = "other";
      }
      if (change === "connection") {
        host.client = null;
      }
      if (change === "epoch") {
        host.connectionEpoch += 1;
      }
      host.chatError = "New conversation error";
      response.reject(new Error("Old control failure"));
      await steering;
      expect(host.chatError).toBe("New conversation error");
      expect(host.request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(
        0,
      );
    },
  );

  it("explains a declined promotion without discarding or resending the original input", async () => {
    const host = createHost(() => ({
      status: "queued",
      reason: "The runtime is compacting. The message remains queued.",
    }));
    await host.steerQueuedChatMessage(rowId);
    expect(host.chatError).toContain("remains queued");
    expect(host.lastError).toBe(host.chatError);
    expect(getChatPendingInputs(host)?.queuedInputs).toHaveLength(1);
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
  });

  it("does not dispatch while disconnected or for an already retired queue row", async () => {
    const host = createHost();
    host.connected = false;
    await host.steerQueuedChatMessage(rowId);
    expect(host.request).not.toHaveBeenCalled();
    host.connected = true;
    applyChatPendingInputs(host, { items: [], total: 0, queuedCount: 0 });
    await host.steerQueuedChatMessage(rowId);
    expect(host.request).not.toHaveBeenCalled();
    expect(host.chatQueue).toEqual([]);
    expect(host.chatError).toBeNull();
  });
});
