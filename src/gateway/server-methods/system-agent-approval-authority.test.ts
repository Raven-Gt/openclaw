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
});
