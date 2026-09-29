// Owner-conversation repair replaces the first failure alert of a streak.
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createTelegramDelivery,
  expectAlertTextContaining,
  setupFailureAlertSuite,
} from "./service.failure-alert.test-helpers.js";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import { loadCronStore } from "./store.js";
import type { CronStoredJob } from "./types.js";

const { withFailureAlertCron } = setupFailureAlertSuite();
type AlertParams = Parameters<typeof withFailureAlertCron>;
type StartRepair = NonNullable<AlertParams[0]["startCronFailureRepair"]>;

const ownerSessionKey = "agent:main:telegram:direct:owner";
const owned = {
  delivery: createTelegramDelivery(),
  owner: { agentId: "main", sessionKey: ownerSessionKey },
  failureAlert: { after: 2, cooldownMs: 0 },
};

function withRepair(
  startCronFailureRepair: StartRepair,
  run: AlertParams[1],
  failureAlert: AlertParams[0]["failureAlert"] = { enabled: true },
) {
  return withFailureAlertCron(
    { scheduler: createTestGatewayScheduler(), failureAlert, startCronFailureRepair },
    run,
  );
}

async function restartCron(storePath: string, startCronFailureRepair: StartRepair) {
  const sendCronFailureAlert = vi.fn<
    NonNullable<ConstructorParameters<typeof CronService>[0]["sendCronFailureAlert"]>
  >(async () => undefined);
  const restarted = new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath,
    cronEnabled: true,
    cronConfig: { failureAlert: { enabled: true } },
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "error" as const, error: "boom" })),
    sendCronFailureAlert,
    startCronFailureRepair,
  });
  await restarted.start();
  return { restarted, sendCronFailureAlert };
}

describe("CronService failure repair", () => {
  it("repairs silently at the threshold, then alerts on the next failure once the repair settles", async () => {
    const startRepair = vi.fn<StartRepair>(async () => "completed");
    await withRepair(startRepair, async ({ cron, sendCronFailureAlert, addJob }) => {
      const job = await addJob("gmail sync", owned);

      await cron.run(job.id, "force");
      expect(startRepair).not.toHaveBeenCalled();
      expect(sendCronFailureAlert).not.toHaveBeenCalled();

      await cron.run(job.id, "force");
      expect(startRepair).toHaveBeenCalledOnce();
      expect(startRepair.mock.calls[0]?.[0]).toMatchObject({
        jobId: job.id,
        ownerSessionKey,
        consecutiveErrors: 2,
        job: { id: job.id },
      });
      expect(sendCronFailureAlert).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(cron.getJob(job.id)?.state.failureAlertIncident?.repair?.settled).toBe(true),
      );

      // A settled repair no longer holds alerts: no need to wait out the in-flight window.
      await cron.run(job.id, "force");
      expect(startRepair).toHaveBeenCalledOnce();
      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      expectAlertTextContaining(sendCronFailureAlert, "automatic repair was attempted");

      await cron.run(job.id, "force");
      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      expect(startRepair).toHaveBeenCalledOnce();
    });
  });

  it("holds failures while the repair is still running, then alerts after its window", async () => {
    const startRepair = vi.fn<StartRepair>(() => createDeferred<"completed">().promise);
    await withRepair(startRepair, async ({ cron, sendCronFailureAlert, addJob }) => {
      const job = await addJob("stuck sync", owned);
      await cron.run(job.id, "force");
      await cron.run(job.id, "force");
      // Failures while the repair can still be running (its own verification runs) are held.
      await cron.run(job.id, "force");
      expect(startRepair).toHaveBeenCalledOnce();
      expect(sendCronFailureAlert).not.toHaveBeenCalled();

      vi.setSystemTime(Date.now() + 16 * 60_000);
      await cron.run(job.id, "force");
      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      expectAlertTextContaining(sendCronFailureAlert, "automatic repair was attempted");
    });
  });

  it("alerts as today when the owner conversation is unavailable, without a second alert", async () => {
    const startRepair = vi.fn<StartRepair>(async () => "unavailable");
    await withRepair(startRepair, async ({ cron, sendCronFailureAlert, addJob }) => {
      sendCronFailureAlert.mockImplementation(async (alert) => {
        await alert.onDeliverySettled({ delivered: true, status: "delivered" });
      });
      const job = await addJob("orphan sync", owned);
      await cron.run(job.id, "force");
      await cron.run(job.id, "force");
      expect(startRepair).toHaveBeenCalledOnce();
      await vi.waitFor(() =>
        expect(cron.getJob(job.id)?.state.failureAlertIncident?.repair?.alerted).toBe(true),
      );
      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      expectAlertTextContaining(sendCronFailureAlert, 'Automation "orphan sync" failed 2 times');
      const text = sendCronFailureAlert.mock.calls[0]?.[0].payload.text ?? "";
      expect(text).not.toContain("repair");

      vi.setSystemTime(Date.now() + 16 * 60_000);
      await cron.run(job.id, "force");
      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
    });
  });

  it.each([
    { name: "no owner conversation", overrides: { owner: undefined }, config: { enabled: true } },
    { name: "repair disabled", overrides: {}, config: { enabled: true, repair: false } },
  ])("keeps the existing alert with $name", async ({ overrides, config }) => {
    const startRepair = vi.fn<StartRepair>(async () => "completed");
    await withRepair(
      startRepair,
      async ({ cron, sendCronFailureAlert, addJob }) => {
        const job = await addJob("plain sync", { ...owned, ...overrides });
        await cron.run(job.id, "force");
        await cron.run(job.id, "force");
        expect(startRepair).not.toHaveBeenCalled();
        expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      },
      config,
    );
  });

  it("drops the fallback alert and settles when the job was disabled while the repair ran", async () => {
    const pending = createDeferred<"failed">();
    const startRepair = vi.fn<StartRepair>(() => pending.promise);
    await withRepair(startRepair, async ({ cron, sendCronFailureAlert, addJob }) => {
      const job = await addJob("disabled mid-repair", owned);
      await cron.run(job.id, "force");
      await cron.run(job.id, "force");
      expect(startRepair).toHaveBeenCalledOnce();

      await cron.update(job.id, { enabled: false });
      pending.resolve("failed");
      // Settled, so a restart does not report the aborted repair as interrupted.
      await vi.waitFor(() =>
        expect(cron.getJob(job.id)?.state.failureAlertIncident?.repair?.settled).toBe(true),
      );
      expect(cron.getJob(job.id)?.state.failureAlertIncident?.repair?.alerted).toBeUndefined();
      expect(sendCronFailureAlert).not.toHaveBeenCalled();
    });
  });

  it.each([
    { outcome: "interrupted", alerts: 1 },
    { outcome: "completed", alerts: 0 },
  ] as const)(
    "reconciles a $outcome repair when the Gateway restarts",
    async ({ outcome, alerts }) => {
      const startRepair = vi.fn<StartRepair>(() =>
        outcome === "completed"
          ? Promise.resolve("completed")
          : createDeferred<"completed">().promise,
      );
      await withRepair(startRepair, async ({ cron, storePath, addJob }) => {
        const job = await addJob("restart sync", owned);
        await cron.run(job.id, "force");
        await cron.run(job.id, "force");
        expect(startRepair).toHaveBeenCalledOnce();
        if (outcome === "completed") {
          await vi.waitFor(() =>
            expect(cron.getJob(job.id)?.state.failureAlertIncident?.repair?.settled).toBe(true),
          );
        }
        // A later run resets the per-cycle status; the repair's own settlement must survive it.
        await cron.run(job.id, "force");
        cron.stop();

        const { restarted, sendCronFailureAlert } = await restartCron(storePath, startRepair);
        try {
          expect(sendCronFailureAlert).toHaveBeenCalledTimes(alerts);
          if (alerts) {
            expectAlertTextContaining(sendCronFailureAlert, "interrupted by a Gateway restart");
          }
          expect(startRepair).toHaveBeenCalledOnce();
        } finally {
          restarted.stop();
        }
      });
    },
  );

  it("leaves a repair that fails after stop to the restarted service's one alert", async () => {
    const pending = createDeferred<"failed">();
    const startRepair = vi.fn<StartRepair>(() => pending.promise);
    await withRepair(startRepair, async ({ cron, storePath, addJob, sendCronFailureAlert }) => {
      const job = await addJob("late failure sync", owned);
      await cron.run(job.id, "force");
      await cron.run(job.id, "force");
      expect(startRepair).toHaveBeenCalledOnce();
      cron.stop();

      const restarted = await restartCron(storePath, startRepair);
      try {
        expect(restarted.sendCronFailureAlert).toHaveBeenCalledOnce();
        expectAlertTextContaining(
          restarted.sendCronFailureAlert,
          "interrupted by a Gateway restart",
        );
        // The retired service's repair fails only now; its fallback must not alert again.
        pending.resolve("failed");
        await pending.promise;
        await setImmediate();
        expect(sendCronFailureAlert).not.toHaveBeenCalled();
        expect(restarted.sendCronFailureAlert).toHaveBeenCalledOnce();
      } finally {
        restarted.restarted.stop();
      }
    });
  });

  it("upgrades v2026.9.6 rows through failure, repair, and silent settlement", async () => {
    // The v2026.9.6 row codec is identical to this head's (row-codec.ts differs only in an
    // export), so saveCronStore writes exactly the rows that release persisted. Its incident
    // state had no repair marker; the second job is mid-incident after that release's alert.
    const nowMs = Date.now();
    const stableJob = (id: string, state: CronStoredJob["state"]): CronStoredJob => ({
      id,
      name: id,
      enabled: true,
      createdAtMs: nowMs - 86_400_000,
      updatedAtMs: nowMs - 3_600_000,
      schedule: { kind: "every", everyMs: 3_600_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "sync", toolsAllow: ["read"] },
      delivery: createTelegramDelivery(),
      owner: { agentId: "main", sessionKey: ownerSessionKey },
      failureAlert: { after: 2, cooldownMs: 0 },
      state,
    });
    const seedJobs = [
      stableJob("fresh-stable", { lastRunStatus: "ok", consecutiveErrors: 0 }),
      stableJob("alerted-stable", {
        lastRunStatus: "error",
        lastError: "temporary upstream error",
        consecutiveErrors: 2,
        lastFailureAlertAtMs: nowMs - 600_000,
        lastFailureNotificationDeliveryStatus: "delivered",
        lastFailureNotificationDelivered: true,
        failureAlertIncident: { signature: "v2026.9.6-incident", scope: "run" },
      }),
    ];
    const startRepair = vi.fn<StartRepair>(async () => "completed");
    await withFailureAlertCron(
      {
        scheduler: createTestGatewayScheduler(),
        failureAlert: { enabled: true },
        startCronFailureRepair: startRepair,
        seedJobs,
      },
      async ({ cron, storePath, sendCronFailureAlert, runIsolatedAgentJob }) => {
        const legacy = (await loadCronStore(storePath)).jobs.find(
          (job) => job.id === "alerted-stable",
        );
        expect(legacy?.state.failureAlertIncident).toEqual({
          signature: "v2026.9.6-incident",
          scope: "run",
        });

        await cron.run("fresh-stable", "force");
        await cron.run("fresh-stable", "force");
        expect(startRepair).toHaveBeenCalledOnce();
        expect(startRepair.mock.calls[0]?.[0].jobId).toBe("fresh-stable");
        expect(sendCronFailureAlert).not.toHaveBeenCalled();
        await vi.waitFor(() =>
          expect(cron.getJob("fresh-stable")?.state.failureAlertIncident?.repair?.settled).toBe(
            true,
          ),
        );

        // The legacy incident's next failure is a new cause for this head: one repair, no alert.
        await cron.run("alerted-stable", "force");
        expect(startRepair).toHaveBeenCalledTimes(2);
        expect(startRepair.mock.calls[1]?.[0].jobId).toBe("alerted-stable");
        expect(sendCronFailureAlert).not.toHaveBeenCalled();

        runIsolatedAgentJob.mockResolvedValueOnce({ status: "ok", delivered: true });
        await cron.run("fresh-stable", "force");
        expect(cron.getJob("fresh-stable")?.state.failureAlertIncident).toBeUndefined();
        expect(sendCronFailureAlert.mock.calls.map((call) => call[0].job.id)).not.toContain(
          "fresh-stable",
        );
        const persisted = (await loadCronStore(storePath)).jobs.find(
          (job) => job.id === "fresh-stable",
        );
        expect(persisted?.state.failureAlertIncident).toBeUndefined();
      },
    );
  });
});
