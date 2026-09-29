/** Evaluation-scoped bundle MCP tools for headless cron scripts. */
import { TOOL_NAME_SEPARATOR } from "../agents/agent-bundle-mcp-names.js";
import { loadSessionMcpConfig } from "../agents/agent-bundle-mcp-runtime-config.js";
import type { BundleMcpToolRuntime } from "../agents/agent-bundle-mcp-types.js";
import {
  wrapToolWithBeforeToolCallHook,
  type HookContext,
} from "../agents/agent-tools.before-tool-call.js";
import type { ResolvedConversationCapabilityProfile } from "../agents/conversation-capability-profile.js";
import { applyFinalEffectiveToolPolicy } from "../agents/embedded-agent-runner/effective-tool-policy.js";
import {
  applyEmbeddedAttemptToolsAllow,
  shouldCreateBundleMcpRuntimeForAttempt,
} from "../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { normalizeToolPolicyName } from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { getPluginToolMeta, setPluginToolMeta } from "../plugins/tool-metadata.js";

export type CronScriptMcpTools = {
  /** Settles once configured servers have connected and listed tools (or failed to). */
  tools: Promise<AnyAgentTool[]>;
  /** Retires the evaluation's MCP runtime, including servers still connecting. */
  dispose: () => Promise<void>;
};

type AcquireCronScriptMcpToolsParams = {
  /** Unique per evaluation: the runtime is never shared with another run. */
  sessionId: string;
  sessionKey: string;
  agentId: string;
  config: OpenClawConfig;
  workspaceDir: string;
  agentDir: string;
  toolsAllow?: string[];
  capabilityProfile: ResolvedConversationCapabilityProfile;
  reservedToolNames: readonly string[];
  hookContext: HookContext;
};

/**
 * A server that fails to start has no listed tools. Exact toolsAllow names for
 * it stay callable so the script receives the startup failure as a tool error.
 */
function createUnavailableServerTools(
  materialized: BundleMcpToolRuntime,
  toolsAllow: readonly string[] | undefined,
): AnyAgentTool[] {
  if (!materialized.diagnostics?.length || !toolsAllow?.length) {
    return [];
  }
  const listed = new Set(materialized.tools.map((tool) => normalizeToolPolicyName(tool.name)));
  const stubs = new Map<string, AnyAgentTool>();
  for (const diagnostic of materialized.diagnostics) {
    const prefix = `${normalizeToolPolicyName(diagnostic.safeServerName)}${TOOL_NAME_SEPARATOR}`;
    for (const entry of toolsAllow) {
      const name = normalizeToolPolicyName(entry);
      const toolName = name.slice(prefix.length);
      if (!name.startsWith(prefix) || !toolName || name.includes("*") || listed.has(name)) {
        continue;
      }
      const message = `MCP server "${diagnostic.serverName}" is unavailable: ${diagnostic.message}`;
      const stub: AnyAgentTool = {
        name,
        label: toolName,
        description: message,
        parameters: { type: "object" },
        execute: async () => {
          throw new Error(message);
        },
      };
      setPluginToolMeta(stub, {
        pluginId: "bundle-mcp",
        optional: false,
        mcp: {
          serverName: diagnostic.serverName,
          safeServerName: diagnostic.safeServerName,
          toolName,
          operation: "tool",
        },
      });
      stubs.set(name, stub);
    }
  }
  return [...stubs.values()];
}

/**
 * Starts the evaluation's own session MCP runtime, or returns undefined when
 * no enabled server remains or the job's toolsAllow cannot reach one.
 * Connection and listing run inside the caller's deadline; `dispose` must run
 * in the caller's `finally`.
 */
export function acquireCronScriptMcpTools(
  params: AcquireCronScriptMcpToolsParams,
): CronScriptMcpTools | undefined {
  // Metadata only: no transport starts until acquisition below.
  const mcpConfigParams = {
    workspaceDir: params.workspaceDir,
    cfg: params.config,
    toolDenylist: params.capabilityProfile.policy.explicitToolDenylist,
    logDiagnostics: false,
  };
  const enabled = shouldCreateBundleMcpRuntimeForAttempt({
    toolsEnabled: true,
    toolsAllow: params.toolsAllow,
    resolveConfiguredMcpNamespaces: () => {
      const { loaded, safeServerNamesByServer } = loadSessionMcpConfig(mcpConfigParams);
      return Object.keys(params.config.mcp?.servers ?? {}).flatMap((name) => {
        const safeName = Object.hasOwn(loaded.mcpServers, name)
          ? safeServerNamesByServer.get(name)
          : undefined;
        return safeName ? [`${safeName}${TOOL_NAME_SEPARATOR}`] : [];
      });
    },
  });
  // Jobs without an enabled server never register a runtime with the session manager.
  if (
    !enabled ||
    Object.keys(loadSessionMcpConfig(mcpConfigParams).loaded.mcpServers).length === 0
  ) {
    return undefined;
  }
  const mcpModule = import("../agents/agent-bundle-mcp-tools.js");
  // Cron runs carry no verified sender, so requester-scoped servers stay fail-closed.
  const acquisition = mcpModule.then(async (mcp) => ({
    mcp,
    lease: await mcp.acquireSessionMcpRuntime({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      cfg: params.config,
      toolDenylist: params.capabilityProfile.policy.explicitToolDenylist,
    }),
  }));
  const materialization = acquisition.then(({ mcp, lease }) =>
    mcp.materializeBundleMcpToolsForRun({
      ...lease,
      agentId: params.agentId,
      reservedToolNames: params.reservedToolNames,
    }),
  );
  const tools = materialization.then((materialized) => {
    const applyPolicy = (candidates: AnyAgentTool[]) =>
      applyFinalEffectiveToolPolicy({
        bundledTools: applyEmbeddedAttemptToolsAllow(candidates, params.toolsAllow, {
          toolMeta: (tool) => getPluginToolMeta(tool),
        }),
        config: params.config,
        workspaceDir: params.workspaceDir,
        conversationCapabilityProfile: params.capabilityProfile,
        warn: (message) => logWarn(message),
      });
    // App views outlive this evaluation; bind them to the same final policy.
    materialized.restrictAppTools?.(applyPolicy(materialized.appTools ?? materialized.tools));
    return applyPolicy([
      ...materialized.tools,
      ...createUnavailableServerTools(materialized, params.toolsAllow),
    ]).map((tool) => wrapToolWithBeforeToolCallHook(tool, params.hookContext));
  });
  void tools.catch(() => undefined);
  let disposal: Promise<void> | undefined;
  return {
    tools,
    dispose: () =>
      (disposal ??= (async () => {
        const acquired = await acquisition.catch(() => undefined);
        if (!acquired) {
          return;
        }
        // Retirement closes transports first, so a deadline-abandoned connect cannot outlive the run.
        await acquired.mcp.retireSessionMcpRuntime({
          sessionId: params.sessionId,
          reason: "cron-script-complete",
          onError: (error, sessionId) =>
            logWarn(`cron: failed to retire script MCP runtime ${sessionId}: ${String(error)}`),
        });
        const materialized = await materialization.catch(() => undefined);
        await materialized?.dispose();
      })()),
  };
}
