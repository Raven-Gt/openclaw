import { describe, expect, it, vi } from "vitest";
import type { CronJob, CronPayload } from "../types.js";
import { maybeEmitFailureAlert, resolveFailureAlert } from "./failure-alerts.js";
import type { CronJobPolicyContext, DeferredCronNotifications } from "./state.js";

const nowMs = Date.parse("2026-09-29T10:00:00Z");
const state: CronJobPolicyContext = {
  deps: {
    nowMs: () => nowMs,
    cronConfig: { failureAlert: { enabled: true } },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
};

function ownedJob(payload: CronPayload, sessionTarget: CronJob["sessionTarget"]): CronJob {
  return {
    id: `owned-${payload.kind}`,
    name: "owned job",
    enabled: true,
    createdAtMs: nowMs - 60_000,
    updatedAtMs: nowMs - 60_000,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget,
    wakeMode: "now",
    payload,
    owner: { agentId: "main", sessionKey: "agent:main:telegram:direct:owner" },
    failureAlert: { after: 2, cooldownMs: 0, channel: "telegram", to: "19098680" },
    state: { consecutiveErrors: 2 },
  };
}

describe("failure repair eligibility", () => {
  it.each([
    {
      name: "agentTurn with a cap",
      job: ownedJob({ kind: "agentTurn", message: "sync", toolsAllow: ["read"] }, "isolated"),
      repairs: true,
    },
    {
      name: "capless agentTurn (runs with the agent's policy today)",
      job: ownedJob({ kind: "agentTurn", message: "sync" }, "isolated"),
      repairs: true,
    },
    {
      name: "script with its own cap",
      job: ownedJob({ kind: "script", script: "json({})", toolsAllow: ["exec"] }, "isolated"),
      repairs: true,
    },
    {
      name: "capless script",
      job: ownedJob({ kind: "script", script: "json({})" }, "isolated"),
      repairs: false,
    },
    {
      name: "main-session systemEvent",
      job: ownedJob({ kind: "systemEvent", text: "check the queue" }, "main"),
      repairs: false,
    },
    {
      name: "command",
      job: ownedJob({ kind: "command", argv: ["true"], env: {}, input: "" }, "isolated"),
      repairs: false,
    },
  ])("$name: repair=$repairs, otherwise the normal alert", ({ job, repairs }) => {
    const deferredNotifications: DeferredCronNotifications = [];
    maybeEmitFailureAlert(state, {
      job,
      alertConfig: resolveFailureAlert(state, job),
      status: "error",
      error: "temporary upstream error",
      consecutiveCount: 2,
      deferredNotifications,
    });
    expect(deferredNotifications.map((notification) => notification.kind)).toEqual([
      repairs ? "failure-repair" : "failure-alert",
    ]);
    expect(job.state.failureAlertIncident?.repair !== undefined).toBe(repairs);
  });
});
