// Registered agent RPC proof for parent-visible session follow-up activity.
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { resolveAgentRunExpiresAtMs } from "../chat-abort.js";
import { withPluginSubagentTestState } from "./agent.spawned-child.test-support.js";
import {
  backendGatewayClient,
  describe0AfterEach0,
  expectRecordFields,
  getAgentTestMocks,
  invokeAgent,
  makeContext,
} from "./agent.test-harness.js";

const mocks = getAgentTestMocks();

describe("gateway agent follow-up activity", () => {
  afterEach(describe0AfterEach0);

  it.each([
    { label: "registered default child follow-up" },
    { label: "completed unlimited child follow-up", previousState: "completed", budget: 0 },
    { label: "yielded unlimited child follow-up", previousState: "yielded", budget: 0 },
    { label: "completed finite child follow-up", previousState: "completed", budget: 90 },
    { label: "yielded finite child follow-up", previousState: "yielded", budget: 90 },
    {
      label: "visible unlimited requester completion wake",
      budget: 0,
      sourceTool: "subagent_announce",
      visible: true,
    },
    {
      label: "nested finite requester completion wake",
      budget: 90,
      sourceTool: "subagent_announce",
    },
    {
      label: "visible unlimited requester settle wake",
      budget: 0,
      sourceTool: "subagent_settle",
      visible: true,
    },
    {
      label: "top-level requester default wake",
      sourceTool: "subagent_settle",
      unregistered: true,
    },
    {
      label: "top-level requester configured wake",
      sourceTool: "subagent_announce",
      unregistered: true,
      configuredTimeout: 1200,
    },
    { label: "explicit override on unlimited child", budget: 0, timeout: 25 },
    { label: "retired child uses the agent default", budget: 0, retired: true },
    {
      label: "recreated child uses the agent default",
      budget: 0,
      priorSessionId: "retired-session",
    },
    { label: "reset child uses the agent default", budget: 90, priorRevision: "retired-revision" },
  ])(
    "preserves timeout policy and prior completion for $label",
    async ({
      previousState,
      budget,
      sourceTool = "sessions_send",
      visible,
      unregistered,
      configuredTimeout,
      timeout,
      retired,
      priorSessionId,
      priorRevision,
    }) => {
      await withPluginSubagentTestState("openclaw-parent-followup-", async ({ stateDir: root }) => {
        resetSubagentRegistryForTests({ persist: false });
        const requesterSessionKey = "agent:main:main";
        const childSessionKey = unregistered
          ? "agent:main:dashboard:parent"
          : visible
            ? "agent:main:dashboard:review"
            : "agent:main:subagent:review";
        const cfg =
          configuredTimeout === undefined
            ? {}
            : { agents: { defaults: { timeoutSeconds: configuredTimeout } } };
        mocks.loadConfigReturn = cfg;
        const previousRunId = "previous-review";
        const runId = "continued-review";
        if (!unregistered) {
          addSubagentRunForTests({
            runId: previousRunId,
            runTimeoutSeconds: budget,
            childSessionKey,
            requesterSessionKey,
            requesterDisplayKey: requesterSessionKey,
            task: "Review the candidate",
            execution: {
              status: "terminal",
              startedAt: 1,
              endedAt: 2,
              ...(retired ? { suppressSessionEffects: true } : {}),
              transcriptTarget: {
                sessionId: priorSessionId ?? "spawned-child-session",
                expectedLifecycleRevision: priorRevision ?? "current-revision",
              },
            },
            ...(previousState === "yielded" ? { pauseReason: "sessions_yield" as const } : {}),
            expectsCompletionMessage: true,
          });
        }
        if (sourceTool !== "sessions_send") {
          addSubagentRunForTests({
            runId: "settled-grandchild",
            childSessionKey: "agent:main:subagent:grandchild",
            requesterSessionKey: childSessionKey,
            requesterDisplayKey: childSessionKey,
            task: "Report findings",
            startedAt: 1,
            endedAt: 2,
            runTimeoutSeconds: 1,
          });
        }
        const previousRun = structuredClone(getSubagentRunByChildSessionKey(childSessionKey));
        mocks.updateSessionStore.mockResolvedValue(undefined);
        const storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
        mocks.userTurnStorePath = storePath;
        mocks.loadSessionEntry.mockReturnValue({
          cfg,
          storePath,
          entry: {
            sessionId: "spawned-child-session",
            lifecycleRevision: "current-revision",
            updatedAt: Date.now(),
            spawnedBy: requesterSessionKey,
            label: "Candidate review",
          },
          canonicalKey: childSessionKey,
        });
        const run = createDeferred<{ payloads: []; meta: { durationMs: number } }>();
        mocks.agentCommand.mockReturnValueOnce(run.promise);
        const context = makeContext();
        const request = {
          message: "Continue reviewing the new changes",
          sessionKey: childSessionKey,
          idempotencyKey: runId,
          ...(timeout === undefined ? {} : { timeout }),
          inputProvenance: {
            kind: "inter_session" as const,
            sourceSessionKey:
              sourceTool === "sessions_send"
                ? requesterSessionKey
                : "agent:main:subagent:grandchild",
            sourceTool,
          },
        };
        const terminal = createDeferred();
        const respond = vi.fn((ok, payload) => {
          if (ok && payload?.status === "ok") {
            terminal.resolve();
          }
        });
        try {
          await invokeAgent(request, {
            context,
            respond,
            reqId: runId,
            client: backendGatewayClient(),
          });
          const expectedSeconds =
            timeout ??
            (unregistered || retired || priorSessionId || priorRevision
              ? undefined
              : (budget ?? 0));
          expect(mocks.agentCommand.mock.calls.at(-1)?.[0].timeout).toBe(
            expectedSeconds?.toString(),
          );
          const admitted = context.chatAbortControllers.get(runId)!;
          const expectedMs =
            expectedSeconds === 0
              ? MAX_TIMER_TIMEOUT_MS
              : (expectedSeconds ?? configuredTimeout ?? 172_800) * 1000;
          expect(admitted.expiresAtMs).toBe(
            resolveAgentRunExpiresAtMs({ now: admitted.startedAtMs, timeoutMs: expectedMs }),
          );
          expect(context.chatAbortControllers.get(runId)?.sessionKey).toBe(childSessionKey);
          const callCount = mocks.agentCommand.mock.calls.length;
          await invokeAgent(request, { context, reqId: "replay", client: backendGatewayClient() });
          expect(mocks.agentCommand).toHaveBeenCalledTimes(callCount);
        } finally {
          run.resolve({ payloads: [], meta: { durationMs: 1 } });
          await terminal.promise;
          expectRecordFields(context.dedupe.get(`agent:${runId}`)?.payload, { status: "ok" });
        }
        expect(getSubagentRunByChildSessionKey(childSessionKey)).toEqual(previousRun);
      });
    },
  );
});
