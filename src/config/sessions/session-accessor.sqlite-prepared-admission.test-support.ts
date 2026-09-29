import { vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as reclamationWorker from "./session-accessor.sqlite-reclamation-worker.js";

/** Pause the real admitted native commit while a later writer enters its existing FIFO. */
export function holdLifecycleProjectionAdmission(databasePath: string) {
  const commitEntered = createDeferred();
  const commitRelease = createDeferred();
  let commitRequests = 0;
  const withWorker = reclamationWorker.withSqliteReclamationWorker;
  vi.spyOn(reclamationWorker, "withSqliteReclamationWorker").mockImplementation(
    (options, claim, run, assertCurrent, signal) =>
      withWorker(
        options,
        claim,
        async (worker) => {
          const execute = worker.run.bind(worker);
          const spy = vi.spyOn(worker, "run").mockImplementation((params) => {
            if (
              params.plan.kind !== "lifecycle-projection-commit" ||
              params.plan.databaseOptions.path !== databasePath
            ) {
              return execute(params);
            }
            return execute({
              ...params,
              withWriteAdmission: (performWrite, diagnostics) =>
                params.withWriteAdmission(async (...admissionArgs) => {
                  if (!admissionArgs[0]) {
                    commitRequests += 1;
                    commitEntered.resolve();
                    await commitRelease.promise;
                  }
                  return performWrite(...admissionArgs);
                }, diagnostics),
            });
          });
          try {
            return await run(worker);
          } finally {
            spy.mockRestore();
          }
        },
        assertCurrent,
        signal,
      ),
  );
  return {
    entered: commitEntered.promise,
    release: () => commitRelease.resolve(),
    requests: () => commitRequests,
  };
}
