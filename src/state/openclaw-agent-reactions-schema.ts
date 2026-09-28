import type { DatabaseSync } from "node:sqlite";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

const SESSION_MESSAGE_REACTIONS_TABLE = "session_message_reactions";

function reactionOrphanPredicate(db: DatabaseSync): string {
  const archives =
    db /* sqlite-allow-raw -- Schema admission must inspect the optional archive table before building its repair predicate. */
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'session_transcript_archives'",
      )
      .get();
  return `NOT EXISTS (SELECT 1 FROM session_transcript_cold_archives AS cold
      WHERE cold.session_id = reaction.session_id)
    AND NOT EXISTS (SELECT 1 FROM transcript_event_identities AS identity
      WHERE identity.session_id = reaction.session_id AND identity.event_id = reaction.message_id)
    ${archives ? "AND NOT EXISTS (SELECT 1 FROM session_transcript_archives AS archive WHERE archive.session_id = reaction.session_id)" : ""}`;
}

/** Only database admission inspects optional shape and downgraded-writer orphans. */
export function hasPendingSessionReactionsRepair(db: DatabaseSync): boolean {
  if (
    !db /* sqlite-allow-raw -- First-open schema admission probes the additive table before Kysely can query it. */
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(SESSION_MESSAGE_REACTIONS_TABLE)
  ) {
    return true;
  }
  return Boolean(
    db /* sqlite-allow-raw -- Admission checks for downgraded-writer orphans before publishing the handle. */
      .prepare(
        `SELECT 1 FROM session_message_reactions AS reaction WHERE ${reactionOrphanPredicate(db)} LIMIT 1`,
      )
      .get(),
  );
}

/** Windows and retained reset/deletion archives share custody; neither is the sole FK owner. */
export function ensureSessionReactionsSchemaInTransaction(db: DatabaseSync): void {
  // sqlite-allow-raw -- Canonical additive schema admission, not a runtime query.
  db.exec(extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, SESSION_MESSAGE_REACTIONS_TABLE));
  // sqlite-allow-raw -- Convergence removes downgraded-writer orphans before IDs can be reused.
  db.exec(`DELETE FROM session_message_reactions AS reaction WHERE ${reactionOrphanPredicate(db)}`);
}
