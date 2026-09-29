import { resolvePersistedOverrideModelRef } from "../../agents/model-selection.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry-read.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { loadSessionEntry, resolveSessionModelRef } from "../session-utils.js";
import type { PrepareAgentRunDispatchParams } from "./agent-run-admission-types.js";

export function resolveAgentRunAdmissionModel(params: PrepareAgentRunDispatchParams) {
  const registeredRun =
    params.request.timeout === undefined && !params.isOneShotModelRun && params.resolvedSessionKey
      ? getLatestLiveSubagentRunByChildSessionKey(params.resolvedSessionKey)
      : undefined;
  const registeredTarget = registeredRun?.execution.transcriptTarget;
  // Reset retains completed rows; their budget must not follow a replaced session.
  const inheritsRegisteredTimeout =
    registeredRun &&
    !registeredRun.execution.suppressSessionEffects &&
    (registeredTarget?.sessionId === undefined ||
      registeredTarget.sessionId === params.getAdmittedSessionId()) &&
    (registeredTarget?.expectedLifecycleRevision === undefined ||
      registeredTarget.expectedLifecycleRevision === params.sessionEntry?.lifecycleRevision);
  const timeoutSeconds =
    params.request.timeout ??
    (inheritsRegisteredTimeout ? (registeredRun.runTimeoutSeconds ?? 0) : undefined);
  const timeoutMs = resolveAgentTimeoutMs({
    cfg: params.cfgForAgent ?? params.cfg,
    overrideSeconds: timeoutSeconds,
  });
  const effectiveProviderOverride =
    params.restoredCronContinuation?.provider ?? params.providerOverride;
  const effectiveModelOverride = params.restoredCronContinuation?.model ?? params.modelOverride;
  const effectiveThinking = params.restoredCronContinuation
    ? params.restoredCronContinuation.thinking
    : params.request.thinking;
  const effectiveAllowModelOverride =
    params.allowModelOverride || params.restoredCronContinuation !== undefined;
  const runtimeConfig = params.cfgForAgent ?? params.cfg;
  const sessionModel = resolveSessionModelRef(
    runtimeConfig,
    params.sessionEntry,
    params.activeSessionAgentId,
  );
  const activeModel = effectiveModelOverride
    ? (resolvePersistedOverrideModelRef({
        defaultProvider: effectiveProviderOverride ?? sessionModel.provider,
        overrideProvider: effectiveProviderOverride,
        overrideModel: effectiveModelOverride,
      }) ?? sessionModel)
    : {
        provider: effectiveProviderOverride ?? sessionModel.provider,
        model: sessionModel.model,
      };
  const resolvedRuntime = {
    harness: resolveEffectiveAgentRuntime({
      cfg: runtimeConfig,
      provider: activeModel.provider,
      modelId: activeModel.model,
      agentId: params.activeSessionAgentId,
      sessionKey: params.resolvedSessionKey,
      sessionEntry: params.sessionEntry,
    }),
    provider: activeModel.provider,
    model: activeModel.model,
  };
  const lifecycleStorePath = params.resolvedSessionKey
    ? loadSessionEntry(params.resolvedSessionKey, {
        ...(params.activeSessionAgentId ? { agentId: params.activeSessionAgentId } : {}),
        clone: false,
        projection: "list",
      }).storePath
    : `agent:${params.activeSessionAgentId}`;
  return {
    timeoutMs,
    timeoutSeconds,
    effectiveProviderOverride,
    effectiveModelOverride,
    effectiveThinking,
    effectiveAllowModelOverride,
    activeModel,
    resolvedRuntime,
    activeModelProvider: activeModel.provider,
    lifecycleStorePath,
  };
}
