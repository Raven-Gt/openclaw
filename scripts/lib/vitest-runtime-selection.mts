import { agentVitestProjectOwners } from "../../test/vitest/vitest.agents-paths.mjs";
import { databaseWorkerCoreTestFiles } from "../../test/vitest/vitest.database-worker-core-paths.mjs";
import { matchesVitestCliSelection } from "../../test/vitest/vitest.pattern-file.ts";
import { fullSuiteVitestShards } from "../../test/vitest/vitest.test-shards.mjs";
import {
  resolveVitestRuntimeConfigScopes,
  type VitestRuntimeTestSelection,
} from "./vitest-build-prerequisites.mts";

/** Bind installed CLI matching without adding runtime dependencies to CI planning. */
export function resolveVitestRuntimeCliSelections(
  config: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): VitestRuntimeTestSelection[] {
  return resolveVitestRuntimeConfigScopes(config).map(({ file: scopedFile, configs, dir }) => ({
    configs,
    matchesFile: (file, included, includePatterns) =>
      file === scopedFile &&
      matchesVitestCliSelection(file, included ? [file] : [], args, dir, env, includePatterns),
  }));
}

/** Keep known worker compilation outside dynamically imported test cases. */
export function shouldPrepareVitestCoreWorkers(
  config: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  includePatterns?: readonly string[] | null,
): boolean {
  const includesProject = (project: string) =>
    config === project ||
    config === "vitest.config.ts" ||
    config === "test/vitest/vitest.config.ts" ||
    fullSuiteVitestShards.some(
      (shard) => shard.config === config && shard.projects.includes(project),
    );
  const codeModeWorker = "src/agents/code-mode.import-boundary.test.ts";
  return (
    (includesProject("test/vitest/vitest.infra.config.ts") &&
      databaseWorkerCoreTestFiles.some((file) =>
        matchesVitestCliSelection(file, [file], args, "", env, includePatterns),
      )) ||
    ((includesProject(agentVitestProjectOwners.core.config) ||
      includesProject(agentVitestProjectOwners.all.config)) &&
      matchesVitestCliSelection(
        codeModeWorker,
        [codeModeWorker],
        args,
        agentVitestProjectOwners.core.dir,
        env,
        includePatterns,
      ))
  );
}
