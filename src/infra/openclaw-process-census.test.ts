import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

const {
  census,
  directory,
  read,
  readlink,
  realpath,
  definitelyDead,
  container,
  darwinCommand,
  windows,
} = vi.hoisted(() => ({
  census: vi.fn(),
  directory: vi.fn(),
  read: vi.fn(),
  readlink: vi.fn(),
  realpath: vi.fn(),
  definitelyDead: vi.fn(),
  container: vi.fn(),
  darwinCommand: vi.fn(),
  windows: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawnSync: census }));
vi.mock("node:fs", () => ({
  readdirSync: directory,
  readFileSync: read,
  readlinkSync: readlink,
  realpathSync: realpath,
  default: { readFileSync: read, realpathSync: realpath, readlinkSync: readlink },
}));
vi.mock("../shared/pid-alive.js", () => ({ isPidDefinitelyDead: definitelyDead }));
vi.mock("./container-environment.js", () => ({ isContainerEnvironment: container }));
vi.mock("../process/supervisor/darwin-process-command.js", () => ({
  readDarwinProcessCommand: darwinCommand,
}));
vi.mock("./windows-process-census.js", () => ({ readWindowsProcessCensus: windows }));
import { inspectOtherOpenClawProcesses } from "./openclaw-process-census.js";

const self = process.pid;
const launcher = self + 1;
const peer = self + 2;
const getuidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
type Process = {
  ppid: number;
  argv: string[];
  state?: string;
  flags?: number;
  cwd?: string | Error;
  environment?: string;
  uid?: number;
  commandError?: Error;
};
let rows: Map<number, Process>;

beforeEach(() => {
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 1000 });
  mockProcessPlatform("linux");
  rows = new Map([
    [1, { ppid: 0, argv: ["/sbin/init"] }],
    [launcher, { ppid: 1, argv: ["node", "/app/openclaw.mjs", "doctor", "--fix"] }],
    [self, { ppid: launcher, argv: ["openclaw-doctor"] }],
  ]);
  definitelyDead.mockReset().mockReturnValue(false);
  container.mockReset().mockReturnValue(false);
  census.mockReset();
  darwinCommand.mockReset();
  windows.mockReset();
  realpath.mockReset().mockImplementation((file: string) => file);
  readlink.mockReset().mockImplementation((file: string) => {
    const pid = Number(/^\/proc\/(\d+)\/cwd$/.exec(file)?.[1]);
    const cwd = rows.get(pid)?.cwd ?? "/app";
    if (cwd instanceof Error) {
      throw cwd;
    }
    return cwd;
  });
  directory.mockReset().mockImplementation(() => Array.from(rows.keys(), String));
  read.mockReset().mockImplementation((file: string) => {
    if (file.endsWith("/package.json")) {
      return JSON.stringify({
        name: file === "/app/package.json" ? "openclaw" : "unrelated-service",
      });
    }
    const match = /^\/proc\/(\d+)\/(stat|cmdline|environ|status)$/.exec(file);
    const pid = Number(match?.[1]);
    const row = rows.get(pid);
    if (!row) {
      throw Object.assign(new Error("Process disappeared"), { code: "ENOENT" });
    }
    if (match?.[2] === "environ") {
      return row.environment ?? "";
    }
    if (match?.[2] === "status") {
      return `Uid:\t${row.uid ?? 1000}\t1000\t1000\t1000\n`;
    }
    if (match?.[2] === "cmdline" && row.commandError) {
      throw row.commandError;
    }
    return match?.[2] === "cmdline"
      ? row.argv.join("\0")
      : `${pid} (name ) (with\nparentheses) ${row.state ?? "S"} ${row.ppid} ${self} 0 0 0 ${row.flags ?? 0}`;
  });
});

it("does not classify an unrelated relative dist/index.js service as OpenClaw", () => {
  rows.set(peer, { ppid: 1, argv: ["node", "dist/index.js"], cwd: "/unrelated-app" });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [] });
});

it("resolves a relative script against the observed OpenClaw installation", () => {
  rows.set(peer, { ppid: 1, argv: ["node", "dist/index.js"], cwd: "/app" });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [peer] });
});

it("preserves a retained runtime used by an orphaned eval worker", () => {
  rows.set(peer, {
    ppid: 1,
    argv: [
      "node",
      "--eval",
      "import(process.argv[1])",
      "/tmp/openclaw-update-runtime-Ab1234/tree/2f/app/dist/terminal.js",
    ],
  });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [peer] });
});

it("reports an unclassified PID instead of claiming it is OpenClaw", () => {
  rows.set(peer, { ppid: 1, argv: ["node", "dist/index.js"] });
  readlink.mockImplementation(() => {
    throw Object.assign(new Error("permission denied"), { code: "EACCES" });
  });
  expect(inspectOtherOpenClawProcesses()).toEqual({
    error: expect.stringContaining(`Could not classify PID ${peer}:`),
  });
});

it("recognizes an owned service marker without guessing from its script name", () => {
  rows.set(peer, {
    ppid: 1,
    argv: ["node", "/vendor/renamed.js"],
    environment: "OPENCLAW_SERVICE_MARKER=openclaw\0",
  });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [peer] });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (getuidDescriptor) {
    Object.defineProperty(process, "getuid", getuidDescriptor);
  } else {
    Reflect.deleteProperty(process, "getuid");
  }
});

it("exempts self and its verified Doctor launcher, but not a same-group peer or child", () => {
  rows.set(peer, { ppid: 1, argv: ["openclaw", "doctor"] });
  rows.set(peer + 1, { ppid: self, argv: ["openclaw-models"] });
  rows.set(peer + 2, { ppid: 1, argv: ["python", "worker.py"] });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [peer, peer + 1] });
});

it.each([
  ["openclaw-gateway"],
  ["openclaw-agent"],
  ["node", "/app/scripts/run-node.mjs", "models", "status"],
  ["node", "/app/dist/entry.js", "agent"],
  ["node", "/app/src/agents/prepared-model-catalog.worker.ts"],
  ["node", "/app/dist/agents/prepared-model-catalog.worker.js"],
  ["/tmp/openclaw-plugin-build-abc123/node_modules/vendor/codex"],
  ["/usr/bin/node", "/tmp/openclaw-plugin-build-abc123/node_modules/tool/cli.js"],
  ["node", "--import=/tmp/openclaw-plugin-build-abc123/loader.js", "app.js"],
  ["node", "openclaw-plugin-build-abc123/script.js"],
  ["node", "/tmp/openclaw-model-catalog-abc123/worker.cjs"],
])("recognizes live command identity %j", (...argv) => {
  rows.set(peer, { ppid: 1, argv });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [peer] });
});

it.each([
  ["openclaw-doctor"],
  ["openclaw-update"],
  ["openclaw", "agent", "--message", "doctor"],
  ["openclaw", "agent", "--message", "openclaw", "doctor"],
])("does not exempt an unverified ancestor %j", (...argv) => {
  rows.set(launcher, { ppid: 1, argv });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [launcher] });
});

it("recognizes the current Doctor launcher with root options and skips kernel threads", () => {
  rows.set(launcher, {
    ppid: 1,
    argv: ["node", "/app/openclaw.mjs", "--profile", "work", "doctor", "--fix"],
  });
  rows.set(peer, { ppid: 1, argv: [], flags: 0x0020_0000 });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [] });
});

it.each(["missing self", "missing ancestor", "unreadable command", "failed enumeration"])(
  "does not authorize cleanup with %s",
  (failure) => {
    if (failure === "missing self") {
      rows.delete(self);
    }
    if (failure === "missing ancestor") {
      rows.delete(launcher);
    }
    if (failure === "unreadable command") {
      const inspect = read.getMockImplementation()!;
      read.mockImplementation((file: string) => {
        if (file.endsWith("/cmdline")) {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
        return inspect(file);
      });
    }
    if (failure === "failed enumeration") {
      directory.mockImplementation(() => {
        throw new Error("denied");
      });
    }
    expect(inspectOtherOpenClawProcesses()).toHaveProperty("error");
  },
);

it("does not mistake an unidentified userspace process for a kernel thread", () => {
  rows.set(peer, { ppid: 1, argv: [] });
  expect(inspectOtherOpenClawProcesses()).toHaveProperty("error");
});

it("does not treat a container's process namespace as complete host visibility", () => {
  container.mockReturnValue(true);
  expect(inspectOtherOpenClawProcesses()).toEqual({
    error: expect.stringContaining("Host process visibility"),
  });
  expect(directory).not.toHaveBeenCalled();
});

it.each([false, true])(
  "preserves unidentified live threads of a zombie leader (dead=%s)",
  (dead) => {
    rows.set(peer, { ppid: 1, argv: [], state: "Z" });
    definitelyDead.mockReturnValue(dead);
    const result = inspectOtherOpenClawProcesses();
    if (dead) {
      expect(result).toEqual({ pids: [] });
    } else {
      expect(result).toHaveProperty("error");
    }
  },
);

it("uses native Darwin arguments and explicit foreign system-service facts", () => {
  mockProcessPlatform("darwin");
  rows.set(peer, { ppid: 1, argv: ["node", "/app with spaces/openclaw.mjs", "status"] });
  census.mockImplementation(() => ({
    status: 0,
    stdout: [...rows].map(([pid, row]) => `${pid} ${self} S ${row.ppid} 501`).join("\n"),
  }));
  darwinCommand.mockImplementation((pid: number) =>
    pid === 1
      ? { argvUnavailable: true, executable: "/sbin/launchd", uid: 0 }
      : { argv: rows.get(pid)!.argv },
  );
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [peer] });
  rows.set(peer, { ppid: 1, argv: ["node", "/unrelated-app/dist/index.js"] });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [] });
  rows.set(peer, { ppid: 1, argv: ["node", "/app/dist/index.js"] });
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [peer] });
  rows.delete(peer);
  expect(inspectOtherOpenClawProcesses()).toEqual({ pids: [] });
  darwinCommand.mockImplementation(() => {
    throw new Error("unreadable live process");
  });
  expect(inspectOtherOpenClawProcesses()).toEqual({
    error: expect.stringContaining("unreadable live process"),
  });
});

it("does not authorize cleanup without exact argv inspection on win32", () => {
  mockProcessPlatform("win32");
  expect(inspectOtherOpenClawProcesses()).toEqual({
    error: expect.stringContaining("Exact process command census is unavailable on win32"),
  });
  expect(census).not.toHaveBeenCalled();
});

const references = { runId: "update-run-123", artifactPaths: ["/tmp/retained runtime"] };
const denied = () => Object.assign(new Error("denied"), { code: "EACCES" });

it("finds orphaned handoff references while excluding only its verified updater launcher", () => {
  rows.set(launcher, {
    ppid: 1,
    argv: ["node", "/app/openclaw.mjs", "update", "repair", references.runId],
  });
  rows.set(peer, { ppid: 1, argv: ["node", "--run-id=update-run-123"] });
  rows.set(peer + 1, { ppid: 1, argv: ["node", "worker.js"], cwd: "/tmp/retained runtime/tree" });
  rows.set(peer + 2, { ppid: 1, argv: ["node", "/tmp/retained runtime/tree/worker.js"] });
  rows.set(peer + 3, {
    ppid: 1,
    argv: [
      "node",
      "update-run-1234",
      "/tmp/retained runtime-other",
      "/tmp/retained runtime.old/worker.js",
    ],
  });
  rows.set(peer + 4, {
    ppid: 1,
    argv: ["node", "other-update-run-123", "/different/tmp/retained runtime"],
  });
  rows.set(peer + 5, {
    ppid: 1,
    argv: ["node", "--eval", 'import("file:///tmp/retained%20runtime/tree/worker.js")'],
  });
  expect(inspectOtherOpenClawProcesses(references)).toEqual({
    matchingPids: [peer, peer + 1, peer + 2, peer + 5],
    unverifiedPids: [],
  });
  rows.set(launcher, { ppid: 1, argv: ["openclaw-update", references.runId] });
  expect(inspectOtherOpenClawProcesses(references).matchingPids).toContain(launcher);
});

it.each(["linux", "darwin"] as const)(
  "checks readable handoff references before excluding opaque foreign %s processes",
  (platform) => {
    mockProcessPlatform(platform);
    rows.set(peer, { ppid: 1, argv: ["node", "worker.js"], cwd: denied() });
    rows.set(peer + 1, { ppid: 1, argv: [], uid: 2000, commandError: denied(), cwd: denied() });
    rows.set(peer + 2, {
      ppid: 1,
      argv: [],
      uid: 2000,
      commandError: denied(),
      cwd: "/tmp/retained runtime/tree",
    });
    rows.set(peer + 3, { ppid: 1, argv: ["node", references.runId], uid: 2000, cwd: denied() });
    if (platform === "darwin") {
      census.mockImplementation((command: string, args: string[]) => {
        if (command === "/bin/ps") {
          return {
            status: 0,
            stdout: [...rows]
              .map(([pid, row]) => `${pid} ${self} S ${row.ppid} ${row.uid ?? 1000}`)
              .join("\n"),
          };
        }
        const pid = Number(args[args.indexOf("-p") + 1]);
        const cwd = rows.get(pid)?.cwd ?? "/app";
        return cwd instanceof Error
          ? { status: 1, stdout: "" }
          : { status: 0, stdout: `p${pid}\0n${cwd}\0` };
      });
      darwinCommand.mockImplementation((pid: number, uid: number) =>
        rows.get(pid)?.commandError
          ? { argvUnavailable: true, uid }
          : { argv: rows.get(pid)!.argv },
      );
    }
    expect(inspectOtherOpenClawProcesses(references)).toEqual({
      matchingPids: [peer + 2, peer + 3],
      unverifiedPids: [peer],
    });
  },
);

it("names an unreadable same-user PID without exposing its process data", () => {
  rows.set(peer, {
    ppid: 1,
    argv: [],
    commandError: Object.assign(new Error("private-process-value"), { code: "EACCES" }),
  });
  const observed = inspectOtherOpenClawProcesses(references);
  expect(observed.unverifiedPids).toEqual([peer]);
  expect(observed.error).toContain("census is incomplete");
  expect(JSON.stringify(observed)).not.toContain("private-process-value");
});

it.each(["container", "missing self", "deadline"])(
  "holds handoff recovery with %s observations",
  (failure) => {
    if (failure === "container") {
      container.mockReturnValue(true);
    } else if (failure === "missing self") {
      rows.delete(self);
    } else {
      vi.spyOn(Date, "now").mockReturnValueOnce(1).mockReturnValue(20_000);
    }
    expect(inspectOtherOpenClawProcesses(references).error).toBeDefined();
  },
);

it.each([100, 200, 300])(
  "excludes a Windows updater ancestor only with an earlier start (%s)",
  (parentStart) => {
    mockProcessPlatform("win32");
    windows.mockReturnValue([
      {
        pid: self,
        parentPid: launcher,
        startIdentity: "200",
        commandLine: "openclaw update repair",
        cwd: "C:\\app",
      },
      {
        pid: launcher,
        parentPid: 0,
        startIdentity: String(parentStart),
        commandLine: "openclaw update repair --run-id=update-run-123",
        cwd: "C:\\app",
      },
      {
        pid: peer,
        commandLine: 'node "C:\\Temp\\Retained Runtime\\tree\\worker.js"',
        cwd: "C:\\app",
      },
      { pid: peer + 1, commandLine: "node worker.js", cwd: "c:/temp/retained runtime/tree" },
      { pid: peer + 2 },
      { pid: peer + 3, foreignOwner: true },
      { pid: peer + 4, foreignOwner: true, commandLine: "node --id=update-run-123" },
      {
        pid: peer + 5,
        commandLine: "node worker.js",
        cwd: "\\\\?\\C:\\Temp\\Retained Runtime\\tree",
      },
      {
        pid: peer + 6,
        commandLine: 'node "file:///C:/Temp/Retained%20Runtime/tree/worker.js"',
        cwd: "C:\\app",
      },
    ]);
    expect(
      inspectOtherOpenClawProcesses({
        ...references,
        artifactPaths: ["c:\\temp\\retained runtime"],
      }),
    ).toEqual({
      matchingPids: [
        ...(parentStart >= 200 ? [launcher] : []),
        peer,
        peer + 1,
        peer + 4,
        peer + 5,
        peer + 6,
      ],
      unverifiedPids: [peer + 2],
    });
  },
);

it.each(["denied", "empty"])("preserves Doctor's refusal for foreign Linux %s argv", (kind) => {
  rows.set(peer, {
    ppid: 1,
    uid: 2000,
    argv: [],
    ...(kind === "denied" ? { commandError: denied() } : {}),
  });
  expect(inspectOtherOpenClawProcesses()).toHaveProperty("error");
});

it("retains known matching PIDs when later inspection exhausts the census budget", () => {
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  rows.set(peer, { ppid: 1, argv: ["node", references.runId] });
  rows.set(peer + 1, { ppid: 1, argv: ["node", "worker.js"] });
  rows.set(peer + 2, { ppid: 1, argv: ["node", "worker.js"] });
  readlink.mockImplementation((file: string) => {
    if (file === `/proc/${peer + 1}/cwd`) {
      now = 20_000;
    }
    return "/app";
  });
  expect(inspectOtherOpenClawProcesses(references)).toMatchObject({
    matchingPids: [peer],
    error: expect.stringContaining("census is incomplete"),
  });
});
