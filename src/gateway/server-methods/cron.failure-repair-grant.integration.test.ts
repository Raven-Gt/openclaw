import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import {
  bindCronManagementGrant,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import type { CronJobPatch } from "../../cron/types.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { cronHandlers } from "./cron.js";
import type { RespondFn } from "./types.js";

const ownerSessionKey = "agent:main:telegram:direct:owner";
const repairRunSessionKey = "agent:main:cron:repair:run:1";
const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string | undefined;
let cron: CronService | undefined;

beforeEach(() => {
  stateDir = tempDirs.make("openclaw-failure-repair-grant-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  setRuntimeConfigSnapshot(cfg);
});

afterEach(async () => {
  cron?.stop();
  cron = undefined;
  if (stateDir) {
    await cleanupSessionStateForTest({ stateDir });
  }
  stateDir = undefined;
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

describe("cron.update with a failure-repair grant", () => {
  it("updates only the repaired job's payload text", async () => {
    const storePath = path.join(expectDefined(stateDir, "state dir"), "cron", "jobs.json");
    const service = new CronService({
      scheduler: createTestGatewayScheduler(),
      nowMs: () => Date.now(),
      storePath,
      cronEnabled: false,
      defaultAgentId: "main",
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    cron = service;
    const add = (name: string) =>
      service.add({
        name,
        enabled: true,
        schedule: { kind: "every", everyMs: 3_600_000 },
        agentId: "main",
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "sync", toolsAllow: ["read", "exec"] },
        delivery: { mode: "none" },
        owner: { agentId: "main", sessionKey: ownerSessionKey },
      });
    const repaired = await add("repaired");
    const other = await add("other");
    const context = createDirectChatContext({
      cron: service,
      cronStorePath: storePath,
      getRuntimeConfig: () => cfg,
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    });

    const runId = "failure-repair-run";
    const operationalRunInstance = createOperationalRunInstanceRef(runId);
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    registerAgentRunContext(runId, {
      agentId: "main",
      sessionKey: repairRunSessionKey,
      sessionId: "repair-session",
    });
    const identity: AgentRuntimeIdentity = {
      kind: "agentRuntime",
      agentId: "main",
      sessionKey: repairRunSessionKey,
      operationalRunInstance,
      delegatedAuthority: { kind: "local", ...authority },
    };
    const capability = expectDefined(
      createCronCreatorAuthorityCapability(
        runId,
        { kind: "unknown" },
        { source: "failure-repair", jobId: repaired.id },
        () => true,
      ),
      "repair capability",
    );
    try {
      await runWithCronCreatorAuthorityCapability(capability, () =>
        withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: repairRunSessionKey,
            operationalRunInstance,
            approvalAuthority: authority,
          },
          async () => {
            const management = expectDefined(bindCronManagementGrant(runId), "repair binding");
            expect(management.failureRepairJobId).toBe(repaired.id);
            expect(() => management.mint("cron.list")).toThrow("repair");
            expect(() => management.mint("cron.remove")).toThrow("repair");
            const update = async (id: string, patch: CronJobPatch) => {
              const client = createSyntheticPluginRuntimeClient();
              client.internal = {
                ...client.internal,
                agentRuntimeIdentity: {
                  ...identity,
                  cronManagementGrant: management.mint("cron.update"),
                },
              };
              const params = { id, patch };
              const respond = vi.fn<RespondFn>();
              await expectDefined(
                cronHandlers["cron.update"],
                "cron.update",
              )({
                req: { type: "req", id: "repair-update", method: "cron.update", params },
                params,
                client,
                context,
                respond,
                isWebchatConnect: () => false,
              });
              const [ok, , error] = expectDefined(respond.mock.calls[0], "update response");
              return { ok, message: error?.message ?? "" };
            };

            await expect(
              update(other.id, { payload: { kind: "agentTurn", message: "hijack" } }),
            ).resolves.toMatchObject({ ok: false, message: expect.stringContaining("not found") });
            // Any cap edit, narrowing included, would drop captured MCP runtime authority.
            for (const toolsAllow of [["read", "write"], ["read"]]) {
              await expect(
                update(repaired.id, { payload: { kind: "agentTurn", toolsAllow } }),
              ).resolves.toMatchObject({
                ok: false,
                message: expect.stringContaining("payload.toolsAllow"),
              });
            }
            await expect(
              update(repaired.id, { schedule: { kind: "every", everyMs: 60_000 } }),
            ).resolves.toMatchObject({ ok: false, message: expect.stringContaining("schedule") });
            await expect(
              update(repaired.id, {
                payload: { kind: "agentTurn", message: "sync with helper" },
              }),
            ).resolves.toMatchObject({ ok: true });
          },
        ),
      );
    } finally {
      releaseAgentRunDelegatedAuthority(authority);
      clearAgentRunContext(runId);
    }

    expect(service.getJob(repaired.id)?.payload).toMatchObject({
      message: "sync with helper",
      toolsAllow: ["read", "exec"],
    });
    expect(service.getJob(other.id)?.payload).toMatchObject({ message: "sync" });
  });
});
