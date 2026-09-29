import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  disposeAllSessionMcpRuntimes,
  getSessionMcpRuntimeManagerForTesting,
  setSessionMcpRuntimeScheduler,
} from "../agents/agent-bundle-mcp-manager-api.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createCronScriptRuntimeFixture as createCronScriptRuntime } from "./trigger-script.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let scheduler: GatewayScheduler;

beforeEach(async () => {
  scheduler = createTestGatewayScheduler();
  await setSessionMcpRuntimeScheduler(scheduler);
});

afterEach(async () => {
  await disposeAllSessionMcpRuntimes();
  await scheduler.stop();
});

// Minimal stdio MCP server: each tools/call records the serving pid for the disposal check.
const SOURCES_SERVER = `
import readline from "node:readline";
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "initialize") reply(message.id, { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "sources", version: "1" } });
  if (message.method === "tools/list") reply(message.id, { tools: [
    { name: "list_sources", inputSchema: { type: "object", properties: { since: { type: "string" } } } },
    { name: "delete_source", inputSchema: { type: "object" } },
  ] });
  if (message.method === "tools/call") reply(message.id, { structuredContent: { pid: process.pid, tool: message.params.name, since: message.params.arguments?.since ?? null, sources: [] }, content: [{ type: "text", text: "listed" }] });
}
`;

function createMcpFixture(extra?: Partial<OpenClawConfig>): OpenClawConfig {
  const root = tempDirs.make("openclaw-cron-mcp-");
  const serverPath = path.join(root, "sources.mjs");
  fs.writeFileSync(serverPath, SOURCES_SERVER);
  return {
    agents: { defaults: { workspace: path.join(root, "workspace") } },
    plugins: { enabled: false },
    mcp: {
      servers: {
        sources: { command: process.execPath, args: [serverPath] },
        broken: { command: process.execPath, args: ["-e", "process.exit(3)"] },
      },
    },
    ...extra,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const QUIET_HOUR_SCRIPT = `
const listed = await MCP.sources.listSources({ since: trigger.state?.cursor ?? "start" });
return {
  fire: false,
  state: {
    cursor: "next",
    listed: listed.structuredContent,
    deleteVisible: typeof MCP.sources.deleteSource === "function",
  },
};
`;

describe("cron script MCP namespace", () => {
  it.each(["trigger", "payload"] as const)(
    "calls an allowed MCP tool, hides a disallowed one, and retires the runtime (%s)",
    async (mode) => {
      const runtime = createCronScriptRuntime({ config: createMcpFixture() });
      const input = {
        jobId: `mcp-${mode}`,
        script: QUIET_HOUR_SCRIPT,
        state: { cursor: "c1" },
        toolsAllow: ["sources__list_sources"],
      };

      const result =
        mode === "trigger"
          ? await runtime.evaluateTrigger(input)
          : await runtime.executePayload(input);

      expect(result).toMatchObject({
        ...(mode === "trigger" ? { kind: "evaluated", fire: false } : { kind: "completed" }),
        state: {
          cursor: "next",
          listed: { tool: "list_sources", since: "c1", sources: [] },
          deleteVisible: false,
        },
      });
      const state = "state" in result ? (result.state as { listed: { pid: number } }) : undefined;
      expect(isProcessAlive(state?.listed.pid ?? 0)).toBe(false);
      expect(getSessionMcpRuntimeManagerForTesting().listRuntimeKeys()).toEqual([]);
    },
  );

  it("follows the owning agent's tool policy when toolsAllow is absent", async () => {
    const runtime = createCronScriptRuntime({
      config: createMcpFixture({ tools: { deny: ["sources__delete_source"] } }),
    });

    await expect(
      runtime.evaluateTrigger({
        jobId: "mcp-agent-policy",
        script: QUIET_HOUR_SCRIPT,
        state: null,
      }),
    ).resolves.toMatchObject({
      kind: "evaluated",
      fire: false,
      state: { listed: { tool: "list_sources", since: "start" }, deleteVisible: false },
    });
  });

  it("surfaces a failed server start as a catchable tool error", async () => {
    const runtime = createCronScriptRuntime({ config: createMcpFixture() });

    const result = await runtime.evaluateTrigger({
      jobId: "mcp-broken",
      script: `
        try {
          await MCP.broken.ping({});
          return { fire: false };
        } catch (error) {
          return { fire: true, message: String(error.message ?? error) };
        }
      `,
      state: null,
      toolsAllow: ["broken__ping", "sources__list_sources"],
    });

    expect(result).toMatchObject({ kind: "evaluated", fire: true });
    expect(result.kind === "evaluated" ? result.message : "").toContain(
      'MCP server "broken" is unavailable',
    );
    expect(getSessionMcpRuntimeManagerForTesting().listRuntimeKeys()).toEqual([]);
  });
});
