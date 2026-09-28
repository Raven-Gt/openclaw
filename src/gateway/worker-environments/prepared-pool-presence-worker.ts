import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "../../state/openclaw-state-worker-store.js";
import type { PreparedPoolPresenceDemand } from "./prepared-pool-presence-store.js";

export function readPreparedPoolPresenceDemand(): Promise<PreparedPoolPresenceDemand | undefined> {
  return executeOpenClawStateWorker(captureOpenClawStateWorkerContext(), {
    type: "preparedPoolPresence.read",
    input: undefined,
  });
}

export function writePreparedPoolPresenceDemand(
  value: PreparedPoolPresenceDemand | null,
  assertCurrent: () => void,
): Promise<PreparedPoolPresenceDemand | undefined> {
  const context = captureOpenClawStateWorkerContext();
  return runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "preparedPoolPresence.write",
        input: value,
      }),
    {
      assertCurrent,
      createAdmission: () => ({
        nativeLocations: [context.admission.databasePath],
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          if (request.stage !== "transaction" && request.stage !== "commit") {
            throw new Error("Prepared-pool presence demand requires transaction admission");
          }
          context.admission.assertCurrent();
          assertCurrent();
          grant();
        }),
      }),
    },
  );
}
