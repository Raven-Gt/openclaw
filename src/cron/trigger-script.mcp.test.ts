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

// Minimal stdio MCP server: records each start, and each call reports the serving pid.
const SOURCES_SERVER = `
import fs from "node:fs";
import readline from "node:readline";
fs.appendFileSync(process.argv[2], "start\\n");
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

function createMcpFixture(extra?: Partial<OpenClawConfig>) {
  const root = tempDirs.make("openclaw-cron-mcp-");
  const serverPath = path.join(root, "sources.mjs");
  const startLog = path.join(root, "starts.log");
  fs.writeFileSync(serverPath, SOURCES_SERVER);
  const config: OpenClawConfig = {
    agents: { defaults: { workspace: path.join(root, "workspace") } },
    plugins: { enabled: false },
    mcp: {
      servers: {
        sources: { command: process.execPath, args: [serverPath, startLog] },
        broken: { command: process.execPath, args: ["-e", "process.exit(3)"] },
      },
    },
    ...extra,
  };
  return {
    config,
    starts: () =>
      (fs.existsSync(startLog) ? fs.readFileSync(startLog, "utf8").split("\n") : []).filter(Boolean)
        .length,
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

const CATCH_BROKEN_SCRIPT = `
try {
  await MCP.broken.ping({});
  return { fire: false };
} catch (error) {
  return { fire: true, message: String(error.message ?? error) };
}
`;

describe("cron script MCP namespace", () => {
  it.each(["trigger", "payload"] as const)(
    "calls an exactly named MCP tool, hides the rest, and retires the runtime (%s)",
    async (mode) => {
      const fixture = createMcpFixture();
      const runtime = createCronScriptRuntime({ config: fixture.config });
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
      expect(fixture.starts()).toBe(1);
      expect(getSessionMcpRuntimeManagerForTesting().listRuntimeKeys()).toEqual([]);
    },
  );

  it("exposes a server-scoped glob within the owning agent's tool policy", async () => {
    const fixture = createMcpFixture({ tools: { deny: ["sources__delete_source"] } });
    const runtime = createCronScriptRuntime({ config: fixture.config });

    await expect(
      runtime.evaluateTrigger({
        jobId: "mcp-server-glob",
        script: QUIET_HOUR_SCRIPT,
        state: null,
        toolsAllow: ["sources__*"],
      }),
    ).resolves.toMatchObject({
      kind: "evaluated",
      fire: false,
      state: { listed: { tool: "list_sources", since: "start" }, deleteVisible: false },
    });
  });

  it.each([
    { caps: "a wildcard", toolsAllow: ["*"] },
    { caps: "no toolsAllow", toolsAllow: undefined },
    { caps: "an unprefixed glob", toolsAllow: ["sour*"] },
  ])("starts no MCP server for $caps", async ({ toolsAllow }) => {
    const fixture = createMcpFixture();
    const runtime = createCronScriptRuntime({ config: fixture.config });

    await expect(
      runtime.evaluateTrigger({
        jobId: "mcp-not-named",
        script: "return { fire: false, state: typeof MCP };",
        state: null,
        toolsAllow,
      }),
    ).resolves.toEqual({ kind: "evaluated", fire: false, state: "undefined" });
    expect(fixture.starts()).toBe(0);
    expect(getSessionMcpRuntimeManagerForTesting().listRuntimeKeys()).toEqual([]);
  });

  it.each([["broken__ping"], ["broken__*"]])(
    "rejects calls to a server that failed to start (%s) with a catchable error",
    async (brokenEntry) => {
      const runtime = createCronScriptRuntime({ config: createMcpFixture().config });

      const result = await runtime.evaluateTrigger({
        jobId: "mcp-broken",
        script: CATCH_BROKEN_SCRIPT,
        state: null,
        toolsAllow: [brokenEntry],
      });

      expect(result).toMatchObject({ kind: "evaluated", fire: true });
      expect(result.kind === "evaluated" ? result.message : "").toContain(
        'MCP server "broken" is unavailable',
      );
      expect(getSessionMcpRuntimeManagerForTesting().listRuntimeKeys()).toEqual([]);
    },
  );
});
