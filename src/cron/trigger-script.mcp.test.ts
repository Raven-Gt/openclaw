import fs from "node:fs";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  disposeAllSessionMcpRuntimes,
  getSessionMcpRuntimeManagerForTesting,
  setSessionMcpRuntimeScheduler,
} from "../agents/agent-bundle-mcp-manager-api.js";
import { testing as mcpRuntimeTesting } from "../agents/agent-bundle-mcp-runtime.js";
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

// Never answers initialize and ignores SIGTERM and stdin EOF, so only a forced kill retires it.
const HUNG_SERVER = `
import net from "node:net";
process.on("SIGTERM", () => {});
process.stdin.on("data", () => {});
process.stdin.on("end", () => {});
net.connect(Number(process.argv[2]), "127.0.0.1");
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

  it("returns ended evaluations while hung MCP servers keep retiring in the background", async () => {
    // Forced shutdown takes 3 s; ended evaluations may wait only the 1 s cleanup grace.
    mcpRuntimeTesting.setBundleMcpDisposeTimeoutMsForTest(3_000);
    // Each fixture holds its socket until the process dies, so every close proves retirement.
    const serverExits: Promise<void>[] = [];
    const allStarted = createDeferred<void>();
    const listener = net.createServer((socket) => {
      serverExits.push(
        new Promise<void>((resolve) => {
          socket.once("close", () => resolve());
        }),
      );
      if (serverExits.length === 3) {
        allStarted.resolve();
      }
    });
    await new Promise<void>((resolve) => {
      listener.listen(0, "127.0.0.1", resolve);
    });
    try {
      const root = tempDirs.make("openclaw-cron-mcp-hung-");
      const serverPath = path.join(root, "hung.mjs");
      fs.writeFileSync(serverPath, HUNG_SERVER);
      const port = (listener.address() as AddressInfo).port;
      const runtime = createCronScriptRuntime({
        config: {
          agents: { defaults: { workspace: path.join(root, "workspace") } },
          plugins: { enabled: false },
          mcp: {
            // Distinct servers: startup is single-flight per server, and each job fills a slot.
            servers: Object.fromEntries(
              [0, 1, 2].map((index) => [
                `hung${index}`,
                { command: process.execPath, args: [serverPath, `${port}`] },
              ]),
            ),
          },
        },
      });
      const controllers = [0, 1, 2].map(() => new AbortController());
      // Three hung connects fill every trigger-evaluation slot.
      const evaluations = controllers.map((controller, index) =>
        runtime.evaluateTrigger({
          jobId: `mcp-hung-${index}`,
          script: `await MCP.hung${index}.ping({}); return { fire: false };`,
          state: null,
          toolsAllow: [`hung${index}__*`],
          abortSignal: controller.signal,
        }),
      );
      await allStarted.promise;

      const abortedAt = performance.now();
      for (const controller of controllers) {
        controller.abort();
      }
      const results = await Promise.all(evaluations);
      const returnedAfterMs = performance.now() - abortedAt;

      expect(
        results.map((result) => (result.kind === "error" ? result.code : result.kind)),
      ).toEqual(["aborted", "aborted", "aborted"]);
      expect(returnedAfterMs).toBeLessThan(2_500);
      await expect(
        runtime.evaluateTrigger({
          jobId: "mcp-after-hung",
          script: "return { fire: false };",
          state: null,
          toolsAllow: [],
        }),
      ).resolves.toEqual({ kind: "evaluated", fire: false });
      await Promise.all(serverExits);
    } finally {
      mcpRuntimeTesting.setBundleMcpDisposeTimeoutMsForTest();
      await new Promise<void>((resolve) => {
        listener.close(() => resolve());
      });
    }
  });
});
