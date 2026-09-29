import { afterEach, expect, test, vi } from "vitest";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { loadSessionEntryReadOnly } from "./session-accessor.sqlite-entry.js";
import {
  createFixture,
  leasesFor,
  observeReclamationWorkers,
  tempDirs,
} from "./session-accessor.sqlite-reclamation-reuse.test-support.js";
import { runSqliteSessionReclamation } from "./session-accessor.sqlite-reclamation-run.js";
import type { SqliteReclamationWorkerMessage } from "./session-accessor.sqlite-reclamation-worker.types.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

test.each(["caller refusal", "source retirement"] as const)(
  "preserves cold native lease custody before preparation acceptance after %s",
  async (failure) => {
    const fixture = createFixture(["victim"]);
    await closeOpenClawAgentDatabaseByPathAsync(fixture.database.path);
    let allowed = true;
    let receivedLease = false;
    let closing: Promise<unknown> | undefined;
    const spawned = observeReclamationWorkers((worker) => {
      worker.on("message", (message: SqliteReclamationWorkerMessage) => {
        if (message.type !== "lease" || receivedLease) {
          return;
        }
        receivedLease = true;
        if (failure === "caller refusal") {
          allowed = false;
        } else {
          closing = closeOpenClawAgentDatabaseByPathAsync(fixture.database.path);
          void closing.catch(() => {});
        }
      });
    });
    const run = () =>
      runSqliteSessionReclamation({
        forceInProcess: false,
        plan: fixture.plans[0]!,
        assertCommitAllowed: () => {
          if (!allowed) {
            throw new Error("cold caller permission revoked");
          }
        },
      });
    try {
      await expect(run()).rejects.toThrow(
        failure === "caller refusal" ? "cold caller permission revoked" : /revoked|closed/,
      );
      expect(receivedLease).toBe(true);
      expect(spawned).toHaveLength(1);
      if (failure === "source retirement") {
        expect(closing).toBeDefined();
        await closing;
        expect(spawned[0]!.threadId).toBe(-1);
        expect(leasesFor(fixture)).toHaveLength(0);
      } else {
        expect(spawned[0]!.threadId).toBeGreaterThan(0);
        expect(leasesFor(fixture)).toHaveLength(1);
      }
      expect(loadSessionEntryReadOnly(fixture.scopes[0]!)).toMatchObject({ sessionId: "victim" });
      if (failure === "caller refusal") {
        allowed = true;
        await expect(run()).resolves.toMatchObject({
          kind: "lifecycle-artifacts",
          value: { removedEntries: 1 },
        });
        expect(spawned).toHaveLength(1);
        expect(loadSessionEntryReadOnly(fixture.scopes[0]!)).toBeUndefined();
      }
    } finally {
      await closing;
      await closeOpenClawAgentDatabaseByPathAsync(fixture.database.path);
    }
    expect(spawned[0]!.threadId).toBe(-1);
    expect(leasesFor(fixture)).toHaveLength(0);
  },
);
