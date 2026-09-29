import { randomUUID } from "node:crypto";
import {
  SYSTEM_AGENT_APPROVAL_DECISIONS,
  SYSTEM_AGENT_APPROVAL_TIMEOUT_MS,
  type SystemAgentApprovalApplicationStatus,
  type SystemAgentApprovalResolved,
  type SystemAgentApprovalRequestPayload,
} from "../../infra/system-agent-approvals.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import { describeSystemAgentPersistentOperation } from "../../system-agent/operations.js";
import {
  broadcastApprovalResolvedEvent,
  buildRequestedApprovalEvent,
  handlePendingApprovalRequest,
} from "./approval-shared.js";
import { runSystemAgentGatewayTask } from "./system-agent-execution.js";
import type { SystemAgentChatSession } from "./system-agent.js";
import type { GatewayRequestContext } from "./types.js";

export function queueDelegatedApproval(params: {
  context: GatewayRequestContext;
  sessions: Map<string, SystemAgentChatSession>;
  session: SystemAgentChatSession;
  sessionId: string;
  delegation: {
    agentId?: string;
    sessionKey?: string;
    turnSourceChannel?: string;
    turnSourceTo?: string;
    turnSourceAccountId?: string;
    turnSourceThreadId?: string | number;
  };
  proposal: NonNullable<ReturnType<SystemAgentChatSession["engine"]["getPendingOperatorProposal"]>>;
}): string {
  if (params.session.pendingApproval?.proposalHash === params.proposal.hash) {
    return params.session.pendingApproval.id;
  }
  const manager = params.context.systemAgentApprovalManager;
  if (!manager) {
    throw new Error("OpenClaw approval registry unavailable");
  }
  const description = describeSystemAgentPersistentOperation(params.proposal.operation);
  const request: SystemAgentApprovalRequestPayload = {
    title: "OpenClaw change",
    description,
    command: description,
    proposalHash: params.proposal.hash,
    allowedDecisions: SYSTEM_AGENT_APPROVAL_DECISIONS,
    agentId: params.delegation.agentId ?? null,
    sessionKey: params.delegation.sessionKey ?? null,
    sessionId: params.sessionId,
    turnSourceChannel: params.delegation.turnSourceChannel ?? null,
    turnSourceTo: params.delegation.turnSourceTo ?? null,
    turnSourceAccountId: params.delegation.turnSourceAccountId ?? null,
    turnSourceThreadId: params.delegation.turnSourceThreadId ?? null,
  };
  const record = manager.create(
    request,
    SYSTEM_AGENT_APPROVAL_TIMEOUT_MS,
    `system-agent:${randomUUID()}`,
  );
  const decisionPromise = manager.register(record, SYSTEM_AGENT_APPROVAL_TIMEOUT_MS);
  params.session.pendingApproval = { id: record.id, proposalHash: params.proposal.hash };
  const requestEvent = buildRequestedApprovalEvent(record);
  const publishApplicationResult = (
    decision: "allow-once" | "allow-always" | "deny",
    applicationStatus: SystemAgentApprovalApplicationStatus,
  ) => {
    const resolvedEvent = {
      id: record.id,
      decision,
      resolvedBy: record.resolvedBy ?? null,
      ts: Date.now(),
      request,
      applicationStatus,
    } satisfies SystemAgentApprovalResolved;
    broadcastApprovalResolvedEvent({
      approvalKind: "system-agent",
      context: params.context,
      record,
      event: resolvedEvent,
    });
    params.context.approvalEvents?.publishResolved("system-agent", resolvedEvent);
  };
  void handlePendingApprovalRequest({
    manager,
    record,
    decisionPromise,
    respond: () => undefined,
    context: params.context,
    requestEventName: "openclaw.approval.requested",
    requestEvent,
    approvalKind: "system-agent",
    twoPhase: true,
    deliverRequest: () => false,
    keepPendingWithoutRoute: true,
    requireDeliveryRoute: false,
    afterDecision: async (decision) => {
      if (!decision) {
        return;
      }
      try {
        const reply = await runWithGatewayIndependentRootWorkContinuation(
          () =>
            runSystemAgentGatewayTask(async () => {
              // The original request has returned; keep approval, audit, and restart drain-visible.
              if (params.sessions.get(params.sessionId) !== params.session) {
                return null;
              }
              if (params.session.pendingApproval?.id === record.id) {
                params.session.pendingApproval = undefined;
              }
              return await params.session.engine.resolveOperatorApproval(
                decision,
                params.proposal.hash,
              );
            }),
          "system-agent:task",
        );
        publishApplicationResult(decision, reply ? "applied" : "not-applied");
      } catch (error) {
        publishApplicationResult(decision, "not-applied");
        throw error;
      }
    },
    afterDecisionErrorLabel: "OpenClaw approval apply failed",
  });
  return record.id;
}
