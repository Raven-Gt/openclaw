import { describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronJobCreate, CronJobPatch, CronPacing } from "../types.js";
import { add, update } from "./ops-mutations.js";
import { createCronServiceState } from "./state.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-pacing-ops" });
const NOW = Date.parse("2026-07-18T12:00:00.000Z");

function makeInput(pacing: CronPacing): CronJobCreate {
  return {
    name: "paced job",
    agentId: "main",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    pacing,
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "check" },
  };
}

async function withState(run: (state: ReturnType<typeof createCronServiceState>) => Promise<void>) {
  const { storePath } = await makeStorePath();
  await run(
    createCronServiceState({
      scheduler: createTestGatewayScheduler(),
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => NOW,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    }),
  );
}

describe("cron pacing validation", () => {
  it("accepts duration strings on create and update", async () => {
    await withState(async (state) => {
      const job = await add(state, makeInput({ min: "15m", max: "4h" }));
      expect(job.pacing).toEqual({ min: "15m", max: "4h" });

      const updated = await update(state, job.id, { pacing: { min: "30m", max: "2h" } });
      expect(updated.pacing).toEqual({ min: "30m", max: "2h" });
    });
  });

  it.each([
    ["no bounds", {}, /pacing requires at least one of min or max/],
    ["zero minimum", { min: "0s" }, /pacing min must be a positive duration/],
    ["negative maximum", { max: "-1m" }, /pacing max must be a positive duration/],
    ["minimum above maximum", { min: "4h", max: "15m" }, /pacing min must not exceed max/],
  ] as const)("rejects %s on create", async (_label, pacing, error) => {
    await withState(async (state) => {
      await expect(add(state, makeInput(pacing))).rejects.toThrow(error);
    });
  });

  it("rejects invalid pacing on update without changing the stored job", async () => {
    await withState(async (state) => {
      const job = await add(state, makeInput({ min: "15m" }));

      await expect(update(state, job.id, { pacing: { max: "0m" } })).rejects.toThrow(
        "cron pacing max must be a positive duration",
      );
      expect(state.store?.jobs[0]?.pacing).toEqual({ min: "15m" });
    });
  });

  it("rejects empty pacing on update without changing the stored job", async () => {
    await withState(async (state) => {
      const job = await add(state, makeInput({ min: "15m" }));

      await expect(update(state, job.id, { pacing: {} })).rejects.toThrow(
        "cron pacing requires at least one of min or max",
      );
      expect(state.store?.jobs[0]?.pacing).toEqual({ min: "15m" });
    });
  });

  it("accepts a nullable pacing patch and clears pacing and its pending slot", async () => {
    await withState(async (state) => {
      const job = await add(state, makeInput({ min: "15m" }));
      const pendingSlot = NOW + 4 * 60 * 60_000;
      await saveCronStore(
        state.deps.storePath,
        {
          version: 1,
          jobs: [
            {
              ...job,
              state: { ...job.state, nextRunAtMs: pendingSlot, pacedNextRunAtMs: pendingSlot },
            },
          ],
        },
        { stateOnly: true },
      );
      const patch = { pacing: null } satisfies CronJobPatch;

      const updated = await update(state, job.id, patch);
      const reloaded = await loadCronStore(state.deps.storePath);

      for (const observed of [updated, state.store?.jobs[0], reloaded.jobs[0]]) {
        expect(observed?.id).toBe(job.id);
        expect(observed?.pacing).toBeUndefined();
        expect(observed?.state.nextRunAtMs).toBe(NOW + 60_000);
        expect(observed?.state.pacedNextRunAtMs).toBeUndefined();
      }
    });
  });

  it.each([
    { label: "an authored anchor", anchorMs: NOW },
    { label: "a missing anchor", anchorMs: undefined },
  ])(
    "preserves a pending paced slot and schedule on an unrelated edit with $label",
    async ({ anchorMs }) => {
      await withState(async (state) => {
        const pendingSlot = NOW + 30 * 60_000;
        const schedule = {
          kind: "every" as const,
          everyMs: 60_000,
          ...(anchorMs === undefined ? {} : { anchorMs }),
        };
        const job = makeCronJob({
          id: "pending-paced-edit",
          agentId: "main",
          createdAtMs: NOW,
          updatedAtMs: NOW,
          pacing: { max: "4h" },
          schedule,
          state: { nextRunAtMs: pendingSlot, pacedNextRunAtMs: pendingSlot },
        });
        await saveCronStore(state.deps.storePath, { version: 1, jobs: [job] });

        const updated = await update(state, job.id, { description: "edited" });
        const reloaded = await loadCronStore(state.deps.storePath);

        for (const observed of [updated, state.store?.jobs[0], reloaded.jobs[0]]) {
          expect(observed?.id).toBe(job.id);
          expect(observed?.description).toBe("edited");
          expect(observed?.schedule).toEqual(schedule);
          expect(observed?.pacing).toEqual({ max: "4h" });
          expect(observed?.state.nextRunAtMs).toBe(pendingSlot);
          expect(observed?.state.pacedNextRunAtMs).toBe(pendingSlot);
        }
      });
    },
  );

  it("recomputes the natural slot when pacing bounds change", async () => {
    await withState(async (state) => {
      const job = await add(state, makeInput({ max: "4h" }));
      const pendingSlot = NOW + 4 * 60 * 60_000;
      await saveCronStore(
        state.deps.storePath,
        {
          version: 1,
          jobs: [
            {
              ...job,
              state: { ...job.state, nextRunAtMs: pendingSlot, pacedNextRunAtMs: pendingSlot },
            },
          ],
        },
        { stateOnly: true },
      );

      const updated = await update(state, job.id, { pacing: { max: "2h" } });
      const reloaded = await loadCronStore(state.deps.storePath);

      for (const observed of [updated, state.store?.jobs[0], reloaded.jobs[0]]) {
        expect(observed?.id).toBe(job.id);
        expect(observed?.pacing).toEqual({ max: "2h" });
        expect(observed?.state.nextRunAtMs).toBe(NOW + 60_000);
        expect(observed?.state.pacedNextRunAtMs).toBeUndefined();
      }
    });
  });

  it.each([
    { kind: "at" as const, at: "2026-07-19T12:00:00.000Z" },
    { kind: "on-exit" as const, command: "true" },
  ])("rejects pacing on a $kind one-shot", async (schedule) => {
    await withState(async (state) => {
      await expect(
        add(state, {
          ...makeInput({ min: "15m" }),
          schedule,
        }),
      ).rejects.toThrow("cron pacing requires an every or cron schedule");
    });
  });

  it("requires clearing pacing when converting a recurring job to a one-shot", async () => {
    await withState(async (state) => {
      const job = await add(state, makeInput({ min: "15m" }));

      await expect(
        update(state, job.id, {
          schedule: { kind: "at", at: "2026-07-19T12:00:00.000Z" },
        }),
      ).rejects.toThrow("cron pacing requires an every or cron schedule");
      expect(state.store?.jobs[0]?.schedule.kind).toBe("every");
      expect(state.store?.jobs[0]?.pacing).toEqual({ min: "15m" });

      const schedule = { kind: "at", at: "2026-07-19T12:00:00.000Z" } as const;
      const updated = await update(state, job.id, { schedule, pacing: null });
      expect(updated.schedule).toEqual(schedule);
      expect(updated.pacing).toBeUndefined();
      expect(state.store?.jobs[0]?.schedule).toEqual(schedule);
      expect(state.store?.jobs[0]?.pacing).toBeUndefined();
    });
  });
});
