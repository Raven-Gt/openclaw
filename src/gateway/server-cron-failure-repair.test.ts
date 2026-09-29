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
  state: { failureAlertIncident: { signature: "incident-a", scope: "run", repair: { atMs: 1 } } },
};

async function repairWith(
  result: Record<string, unknown>,
  getJob: (jobId: string) => CronStoredJob | undefined = () => job,
) {
  runCronIsolatedAgentTurn.mockResolvedValueOnce(result);
  return await runGatewayCronFailureRepair({
    request: {
      jobId: job.id,
      ownerSessionKey,
      consecutiveErrors: 2,
      incidentSignature: "incident-a",
      repairAtMs: 1,
      job,
    },
    getJob,
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

  it.each([
    { name: "still open", incident: job.state.failureAlertIncident, live: true },
    { name: "resolved by a success", incident: undefined, live: false },
    {
      name: "replaced by a new incident",
      incident: { signature: "incident-b", scope: "run" as const },
      live: false,
    },
    {
      name: "escalated to an alert",
      incident: {
        signature: "incident-a",
        scope: "run" as const,
        repair: { atMs: 1, alerted: true as const },
      },
      live: false,
    },
  ])("binds the repair grant to its incident while it is $name", async ({ incident, live }) => {
    let current: CronStoredJob = job;
    await repairWith({ status: "ok", delivered: true }, () => current);
    const grant = runCronIsolatedAgentTurn.mock.lastCall?.[0]?.cronManagement;
    expect(grant?.entitlement).toMatchObject({ source: "failure-repair", jobId: job.id });
    expect(grant?.entitlement.isCurrent()).toBe(true);
    current = { ...job, state: { ...job.state, failureAlertIncident: incident } };
    expect(grant?.entitlement.isCurrent()).toBe(live);
    // Incident liveness gates only automation management, not the rest of the repair turn.
    expect(grant?.isCurrent()).toBe(true);
  });

  it.each([
    { cap: ["read"], expected: ["read", "automations"], editsWorkspace: false },
    { cap: ["read", "exec"], expected: ["read", "exec", "automations"], editsWorkspace: true },
    { cap: ["*"], expected: ["*"], editsWorkspace: true },
  ])(
    "keeps the job's tool cap $cap plus the scoped automations tool",
    async ({ cap, expected, editsWorkspace }) => {
      const capped: CronStoredJob = {
        ...job,
        payload: { kind: "agentTurn", message: "sync", toolsAllow: cap },
      };
      runCronIsolatedAgentTurn.mockResolvedValueOnce({ status: "ok", delivered: true });
      await runGatewayCronFailureRepair({
        request: {
          jobId: job.id,
          ownerSessionKey,
          consecutiveErrors: 2,
          incidentSignature: "incident-a",
          repairAtMs: 1,
          job: capped,
        },
        getJob: () => capped,
        storePath: "/tmp/openclaw-failure-repair-test/jobs.json",
        deps: {} as never,
        resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
        runSchedulerOwned: (run) => run(),
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      const request = runCronIsolatedAgentTurn.mock.lastCall?.[0];
      expect(request?.job.payload.toolsAllow).toEqual(expected);
      expect(request?.job.scheduledToolPolicy).toEqual(capped.scheduledToolPolicy);
      expect(String(request?.message).includes("Edit the workspace helper script")).toBe(
        editsWorkspace,
      );
    },
  );
});
