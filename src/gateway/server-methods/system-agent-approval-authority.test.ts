// Covers the delegated run fence between reviewer resolution and the final effect.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { queueDelegatedApproval } from "./system-agent-approval.js";
import type { SystemAgentChatSession } from "./system-agent.js";
import type { GatewayRequestContext } from "./types.js";

afterEach(() => {
  resetAgentRunRegistryForTest();
});

describe("queueDelegatedApproval authority", () => {
  it("blocks the persistent effect when its delegated run closes after review", async () => {
    const proposal = {
      operation: { kind: "gateway-restart" as const },
      hash: "a".repeat(64),
    };
    const persistentEffect = vi.fn();
    const resolveOperatorApproval = vi.fn(
      async (
        _decision: "allow-once" | "allow-always" | "deny" | null,
        _proposalHash: string,
        beforePersistentApply?: () => void,
      ) => {
        beforePersistentApply?.();
        persistentEffect();
        return { text: "Applied", action: "none" as const };
      },
    );
    const session = {
      engine: { getPendingOperatorProposal: () => proposal, resolveOperatorApproval },
      welcome: "",
      lastUsedAt: 1,
      ownerKey: "agent:main:main",
    } as unknown as SystemAgentChatSession;
    const sessions = new Map([["delegated-session", session]]);
    const operationalRunInstance = {
      instanceId: "delegated-approval-instance",
      runId: "delegated-approval-run",
    };
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    let receiptAuthorityChecks = 0;
    const manager = new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const publishResolved = vi.fn();
    const context = {
      systemAgentApprovalManager: manager,
      approvalEvents: { publishRequested: vi.fn(() => 1), publishResolved },
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),
      hasExecApprovalClients: () => true,
    } as unknown as GatewayRequestContext;

    const approvalId = await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance,
        receiptAuthority: () => {
          receiptAuthorityChecks += 1;
          if (receiptAuthorityChecks === 1) {
            return true;
          }
          releaseAgentRunDelegatedAuthority(authority);
          return false;
        },
      },
      () =>
        queueDelegatedApproval({
          context,
          sessions,
          session,
          sessionId: "delegated-session",
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
          proposal,
        }),
    );

    expect(manager.resolve(approvalId, "allow-once", "operator-ui")).toBe(true);
    await vi.waitFor(() =>
      expect(publishResolved).toHaveBeenCalledWith(
        "system-agent",
        expect.objectContaining({ applicationStatus: "not-applied" }),
      ),
    );
    expect(receiptAuthorityChecks).toBe(2);
    expect(resolveOperatorApproval).toHaveBeenCalledWith(
      "allow-once",
      proposal.hash,
      expect.any(Function),
    );
    expect(persistentEffect).not.toHaveBeenCalled();
  });

  it("replaces a same-proposal approval owned by a closed prior run", async () => {
    const proposal = {
      operation: { kind: "gateway-restart" as const },
      hash: "b".repeat(64),
    };
    const session = {
      engine: {
        getPendingOperatorProposal: () => proposal,
        resolveOperatorApproval: vi.fn(async () => ({
          text: "Applied",
          action: "none" as const,
          applied: true,
        })),
      },
      welcome: "",
      lastUsedAt: 1,
      ownerKey: "agent:main:main",
    } as unknown as SystemAgentChatSession;
    const sessions = new Map([["delegated-session", session]]);
    const manager = new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const context = {
      systemAgentApprovalManager: manager,
      approvalEvents: { publishRequested: vi.fn(() => 1), publishResolved: vi.fn() },
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),
      hasExecApprovalClients: () => true,
    } as unknown as GatewayRequestContext;
    const firstRun = { instanceId: "first-instance", runId: "first-run" };
    const firstAuthority = claimAgentRunDelegatedAuthority(firstRun);
    const queue = (operationalRunInstance: { instanceId: string; runId: string }) =>
      withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey: "agent:main:main", operationalRunInstance },
        () =>
          queueDelegatedApproval({
            context,
            sessions,
            session,
            sessionId: "delegated-session",
            delegation: { agentId: "main", sessionKey: "agent:main:main" },
            proposal,
          }),
      );

    const firstId = await queue(firstRun);
    releaseAgentRunDelegatedAuthority(firstAuthority);
    const secondRun = { instanceId: "second-instance", runId: "second-run" };
    const secondAuthority = claimAgentRunDelegatedAuthority(secondRun);
    const secondId = await queue(secondRun);

    expect(secondId).not.toBe(firstId);
    expect(session.pendingApproval).toEqual({ id: secondId, proposalHash: proposal.hash });
    expect(manager.getSnapshot(firstId)).toMatchObject({
      resolvedAtMs: expect.any(Number),
      terminalReason: "run-aborted",
    });
    expect(manager.getSnapshot(secondId)?.resolvedAtMs).toBeUndefined();
    releaseAgentRunDelegatedAuthority(secondAuthority);
  });

  it("publishes denied replies as not applied", async () => {
    const proposal = {
      operation: { kind: "gateway-restart" as const },
      hash: "c".repeat(64),
    };
    const resolveOperatorApproval = vi.fn(async () => ({
      text: "Denied. No change.",
      action: "none" as const,
      applied: false,
    }));
    const session = {
      engine: { getPendingOperatorProposal: () => proposal, resolveOperatorApproval },
      welcome: "",
      lastUsedAt: 1,
      ownerKey: "agent:main:main",
    } as unknown as SystemAgentChatSession;
    const sessions = new Map([["delegated-session", session]]);
    const operationalRunInstance = { instanceId: "denied-instance", runId: "denied-run" };
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    const manager = new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const publishResolved = vi.fn();
    const context = {
      systemAgentApprovalManager: manager,
      approvalEvents: { publishRequested: vi.fn(() => 1), publishResolved },
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),
      hasExecApprovalClients: () => true,
    } as unknown as GatewayRequestContext;
    const approvalId = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: "agent:main:main", operationalRunInstance },
      () =>
        queueDelegatedApproval({
          context,
          sessions,
          session,
          sessionId: "delegated-session",
          delegation: { agentId: "main", sessionKey: "agent:main:main" },
          proposal,
        }),
    );

    expect(manager.resolve(approvalId, "deny", "operator-ui")).toBe(true);
    await vi.waitFor(() =>
      expect(publishResolved).toHaveBeenCalledWith(
        "system-agent",
        expect.objectContaining({ applicationStatus: "not-applied" }),
      ),
    );
    expect(resolveOperatorApproval).toHaveBeenCalledWith(
      "deny",
      proposal.hash,
      expect.any(Function),
    );
    releaseAgentRunDelegatedAuthority(authority);
  });
});
