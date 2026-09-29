// Owner-conversation repair replaces the first failure alert of a streak.
import { describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createTelegramDelivery,
  expectAlertTextContaining,
  setupFailureAlertSuite,
} from "./service.failure-alert.test-helpers.js";

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

describe("CronService failure repair", () => {
  it("repairs silently at the threshold, then alerts naming the repair if failures continue", async () => {
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

      // Failures while the repair can still be running (its own verification runs) are held.
      await cron.run(job.id, "force");
      expect(sendCronFailureAlert).not.toHaveBeenCalled();

      vi.setSystemTime(Date.now() + 16 * 60_000);
      await cron.run(job.id, "force");
      expect(startRepair).toHaveBeenCalledOnce();
      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      expectAlertTextContaining(sendCronFailureAlert, "automatic repair was attempted");

      await cron.run(job.id, "force");
      expect(sendCronFailureAlert).toHaveBeenCalledOnce();
      expect(startRepair).toHaveBeenCalledOnce();
    });
  });

  it("does not send a recovered notice for a silent repair", async () => {
    const startRepair = vi.fn<StartRepair>(async () => "completed");
    await withRepair(
      startRepair,
      async ({ cron, sendCronFailureAlert, runIsolatedAgentJob, addJob }) => {
        const job = await addJob("meeting sync", owned);
        await cron.run(job.id, "force");
        await cron.run(job.id, "force");
        expect(startRepair).toHaveBeenCalledOnce();

        runIsolatedAgentJob.mockResolvedValueOnce({ status: "ok", delivered: true });
        await cron.run(job.id, "force");
        expect(sendCronFailureAlert).not.toHaveBeenCalled();
        expect(cron.getJob(job.id)?.state.failureAlertIncident).toBeUndefined();
      },
    );
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
});
