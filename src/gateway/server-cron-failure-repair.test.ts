import { describe, expect, it, vi } from "vitest";
import type { CronStoredJob } from "../cron/types.js";

const runCronIsolatedAgentTurn = vi.hoisted(() => vi.fn());
vi.mock("../cron/isolated-agent.js", () => ({ runCronIsolatedAgentTurn }));
vi.mock("../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryInWorker: async () => ({ sessionId: "owner-session", updatedAt: 1 }),
}));
vi.mock("../cron/store/read-only.js", () => ({ readCronRunRecords: async () => [] }));
vi.mock("../process/gateway-work-admission.js", () => ({
  runWithGatewayDetachedWorkContinuation: (run: () => Promise<unknown>) => run(),
}));

const { runGatewayCronFailureRepair } = await import("./server-cron-failure-repair.js");

const ownerSessionKey = "agent:main:telegram:direct:owner";
const job: CronStoredJob = {
  id: "failing-job",
  name: "failing job",
  enabled: true,
  createdAtMs: 1,
  updatedAtMs: 1,
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "sync", toolsAllow: ["read"] },
  owner: { agentId: "main", sessionKey: ownerSessionKey },
  state: {},
};

async function repairWith(result: Record<string, unknown>) {
  runCronIsolatedAgentTurn.mockResolvedValueOnce(result);
  return await runGatewayCronFailureRepair({
    request: { jobId: job.id, ownerSessionKey, consecutiveErrors: 2, job },
    getJob: () => job,
    storePath: "/tmp/openclaw-failure-repair-test/jobs.json",
    deps: {} as never,
    resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
    runSchedulerOwned: (run) => run(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}

describe("runGatewayCronFailureRepair", () => {
  it.each([
    {
      name: "delivered to the owner conversation",
      result: { status: "ok", delivered: true },
      expected: "completed",
    },
    {
      name: "intentionally silent",
      result: { status: "ok", delivered: false, deliverySuppressionReason: "silent" },
      expected: "completed",
    },
    {
      name: "not delivered",
      result: { status: "ok", delivered: false, deliveryError: "commit failed" },
      expected: "failed",
    },
    { name: "an execution error", result: { status: "error", error: "boom" }, expected: "failed" },
  ])("treats a repair turn that was $name as $expected", async ({ result, expected }) => {
    await expect(repairWith(result)).resolves.toBe(expected);
  });
});
