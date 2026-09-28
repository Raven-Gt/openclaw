import path from "node:path";
import { pathToFileURL } from "node:url";
import { splitArgsPreservingQuotes } from "../daemon/arg-split.js";
import { readDarwinProcessCommand } from "../process/supervisor/darwin-process-command.js";
import {
  readProcessGroupMembers,
  type ProcessCommand,
} from "../process/supervisor/service-child-group-ownership.js";
import { isPidDefinitelyDead } from "../shared/pid-alive.js";
import { escapeRegExp } from "../shared/regexp.js";
import { getRootOptionAwareCommandPath } from "./cli-root-options.js";
import { isContainerEnvironment } from "./container-environment.js";
import { classifyOpenClawArgv, readProcessWorkingDirectory } from "./gateway-process-argv.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { readWindowsProcessCensus } from "./windows-process-census.js";

const workerEntrypoints = Object.values(runtimeProcessEntrypoints).flatMap((entry) => [
  path.posix.normalize(`src/infra/${entry.sourceWorkerName}.ts`),
  `dist/${entry.distWorkerPath}`,
]);

type HandoffReferences = { runId: string; artifactPaths: readonly string[] };
type CensusResult = { matchingPids: number[]; unverifiedPids: number[]; error?: string };
type CensusProcess = { pid: number; state: string; command?: { ppid: number } & ProcessCommand };

/** Default custody decisions stay conservative; reference inspection also reports partial evidence. */
export function inspectOtherOpenClawProcesses(references: HandoffReferences): CensusResult;
export function inspectOtherOpenClawProcesses(): { pids: number[] } | { error: string };
export function inspectOtherOpenClawProcesses(handoff?: HandoffReferences) {
  const result: CensusResult = { matchingPids: [], unverifiedPids: [] };
  try {
    if (process.platform === "linux" && isContainerEnvironment()) {
      throw new Error(
        "Host process visibility cannot be established from this container. Run Doctor on the host after stopping OpenClaw containers that share its temporary directory.",
      );
    }
    const windows = process.platform === "win32";
    const deadline = Date.now() + (handoff ? 15_000 : 1_000);
    const native = windows && handoff ? [...readWindowsProcessCensus(15_000)] : undefined;
    const nativeByPid = new Map(native?.map((entry) => [entry.pid, entry]));
    const processes: CensusProcess[] = native?.map(({ pid, parentPid, commandLine }) => ({
      pid,
      state: "",
      command:
        commandLine && parentPid !== undefined
          ? {
              ppid: parentPid,
              argv:
                splitArgsPreservingQuotes(commandLine, { escapeMode: "backslash-quote-only" }) ??
                [],
            }
          : undefined,
    })) ?? [
      ...readProcessGroupMembers(handoff ? 15_000 : 1_000, {
        readDarwinCommand: readDarwinProcessCommand,
      }),
    ];
    const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
    const current = byPid.get(process.pid);
    if (
      !current ||
      (!handoff &&
        processes.some(
          (entry) => !entry.command || (process.platform === "linux" && !("argv" in entry.command)),
        ))
    ) {
      throw new Error("OpenClaw process census is incomplete.");
    }
    const launchers = new Set<number>();
    const ancestors = new Set<number>([process.pid]);
    let child = current;
    let parentPid = current.command?.ppid ?? 0;
    while (parentPid > 0) {
      const parent = byPid.get(parentPid);
      if (!parent?.command || ancestors.has(parentPid)) {
        if (handoff) {
          break;
        }
        throw new Error("OpenClaw process ancestry is incomplete.");
      }
      const parentStart = nativeByPid.get(parentPid)?.startIdentity;
      const childStart = nativeByPid.get(child.pid)?.startIdentity;
      if (windows && (!parentStart || !childStart || BigInt(parentStart) >= BigInt(childStart))) {
        break;
      }
      ancestors.add(parentPid);
      if ("argv" in parent.command) {
        const { argv, serviceMarker } = parent.command;
        const identity = classifyOpenClawArgv(argv, {
          pid: parentPid,
          serviceMarker,
          cwd: nativeByPid.get(parentPid)?.cwd,
          additionalEntrypoints: workerEntrypoints,
        });
        // Only a verified CLI launcher in this inspector's ancestry is exempt.
        if (
          identity.kind === "openclaw" &&
          identity.entryIndex !== undefined &&
          getRootOptionAwareCommandPath(["node", ...argv.slice(identity.entryIndex)], 1)[0] ===
            (handoff ? "update" : "doctor")
        ) {
          launchers.add(parentPid);
        }
      }
      child = parent;
      parentPid = parent.command.ppid;
    }
    const normalize = (value: string) =>
      windows
        ? value
            .replaceAll("\\", "/")
            .replace(/\/{2,}\?\/UNC\//gi, "//")
            .replace(/\/{2,}\?\//g, "")
            .replace(/\/{2,}/g, "/")
            .toLowerCase()
        : value;
    const paths =
      handoff?.artifactPaths.flatMap((value) => [
        value.replace(/[\\/]+$/, ""),
        pathToFileURL(value, { windows }).href,
      ]) ?? [];
    const literal = (value: string) => escapeRegExp(normalize(value));
    const matches = new RegExp(
      `(?:^|[^\\w-])(?:${literal(handoff?.runId ?? "")}(?=$|[^\\w-])|(?:${paths.map(literal).join("|") || "(?!)"})(?=$|[/\\s"'\x60);,\\]]))`,
    );
    for (const { pid, state, command } of processes) {
      if (handoff && Date.now() >= deadline) {
        throw new Error("Process census deadline exceeded");
      }
      if (pid === process.pid || launchers.has(pid)) {
        continue;
      }
      if ((state?.startsWith("Z") || handoff) && isPidDefinitelyDead(pid)) {
        continue;
      }
      const argv = command && "argv" in command ? command.argv : undefined;
      if (handoff) {
        if (!windows && argv?.length === 0) {
          continue;
        }
        const observation = nativeByPid.get(pid);
        const cwd = observation?.cwd ?? readProcessWorkingDirectory(pid);
        const texts = [...(argv ?? []), observation?.commandLine ?? "", cwd ?? ""];
        if (texts.some((value) => matches.test(normalize(value)))) {
          result.matchingPids.push(pid);
          continue;
        }
        const foreign =
          observation?.foreignOwner ||
          (command?.uid !== undefined &&
            process.getuid?.() !== undefined &&
            command.uid !== process.getuid?.());
        if (((!argv && observation?.commandLine === undefined) || cwd === undefined) && !foreign) {
          result.unverifiedPids.push(pid);
        }
        continue;
      }
      if (!argv) {
        continue;
      }
      // Retained terminal writers can use node --eval with the runtime path in argv.
      if (
        argv.some((arg) =>
          /(?:^|[/\\])openclaw-update-runtime-[A-Za-z0-9]{6}(?:[/\\]|$)/u.test(arg),
        )
      ) {
        result.matchingPids.push(pid);
        continue;
      }
      const identity = classifyOpenClawArgv(argv, {
        pid,
        serviceMarker: command && "argv" in command ? command.serviceMarker : undefined,
        additionalEntrypoints: workerEntrypoints,
      });
      if (identity.kind === "unclassified") {
        throw new Error(`Could not classify PID ${pid}: ${identity.reason}`);
      }
      if (identity.kind === "openclaw") {
        result.matchingPids.push(pid);
      }
    }
  } catch (error) {
    if (handoff) {
      const pid = /Could not classify PID (\d+):/.exec(error instanceof Error ? error.message : "");
      if (pid) {
        result.unverifiedPids.push(Number(pid[1]));
      }
    }
    result.error = handoff
      ? "Host process census is incomplete; verify process-inspection permissions and retry update repair."
      : `Could not inspect OpenClaw processes: ${String(error)}`;
  }
  return handoff ? result : result.error ? { error: result.error } : { pids: result.matchingPids };
}
