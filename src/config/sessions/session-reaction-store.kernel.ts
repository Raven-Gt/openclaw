import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type {
  DB as OpenClawAgentKyselyDatabase,
  SessionReactions,
} from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { SessionWorkStartInvalidatedError } from "./lifecycle.js";
import { readSessionEntryInstanceId } from "./session-accessor.sqlite-entry-identity.js";

export type StoredMessageReactionSummary = {
  emoji: string;
  count: number;
  identities: Array<{ id: string; label?: string }>;
};

export type SetSessionReactionParams = {
  messageId: string;
  emoji: string;
  identityId: string;
  identityLabel?: string;
  remove?: boolean;
  expectedSessionId: string;
};

export class SessionReactionLimitError extends Error {
  constructor() {
    super("reaction limit reached");
    this.name = "SessionReactionLimitError";
  }
}

function reactionDb(database: OpenClawAgentDatabase) {
  return getNodeSqliteKysely<Pick<OpenClawAgentKyselyDatabase, "session_reactions">>(database.db);
}

function summarizeReactions(rows: SessionReactions[]): StoredMessageReactionSummary[] {
  const summaries = new Map<string, StoredMessageReactionSummary>();
  for (const row of rows) {
    let summary = summaries.get(row.emoji);
    if (!summary) {
      summary = { emoji: row.emoji, count: 0, identities: [] };
      summaries.set(row.emoji, summary);
    }
    summary.count += 1;
    summary.identities.push({
      id: row.identity_id,
      ...(row.identity_label ? { label: row.identity_label } : {}),
    });
  }
  return [...summaries.values()];
}

/** `changed` is false for an add that already exists or a remove with nothing to remove. */
export type SessionReactionWrite = {
  reactions: StoredMessageReactionSummary[];
  changed: boolean;
};

function reactionRows(database: OpenClawAgentDatabase, sessionKey: string, sessionId: string) {
  return reactionDb(database)
    .selectFrom("session_reactions")
    .selectAll()
    .where("session_key", "=", sessionKey)
    .where("session_id", "=", sessionId)
    .orderBy("created_at")
    .orderBy("emoji")
    .orderBy("identity_id");
}

export function setSessionReactionInDatabase(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  params: SetSessionReactionParams,
): SessionReactionWrite {
  if (readSessionEntryInstanceId(database, sessionKey) !== params.expectedSessionId) {
    throw new SessionWorkStartInvalidatedError("session changed before reaction mutation");
  }
  const db = reactionDb(database);
  const rows = executeSqliteQuerySync(
    database.db,
    reactionRows(database, sessionKey, params.expectedSessionId).where(
      "message_id",
      "=",
      params.messageId,
    ),
  ).rows;
  const existing = rows.some(
    (row) => row.emoji === params.emoji && row.identity_id === params.identityId,
  );
  if (params.remove) {
    if (!existing) {
      return { reactions: summarizeReactions(rows), changed: false };
    }
    executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("session_reactions")
        .where("session_key", "=", sessionKey)
        .where("session_id", "=", params.expectedSessionId)
        .where("message_id", "=", params.messageId)
        .where("emoji", "=", params.emoji)
        .where("identity_id", "=", params.identityId),
    );
  } else {
    if (existing) {
      return { reactions: summarizeReactions(rows), changed: false };
    }
    const count =
      executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("session_reactions")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("session_key", "=", sessionKey)
          .where("session_id", "=", params.expectedSessionId),
      )?.count ?? 0;
    if (
      count >= 5_000 ||
      rows.filter((row) => row.identity_id === params.identityId).length >= 20
    ) {
      throw new SessionReactionLimitError();
    }
    executeSqliteQuerySync(
      database.db,
      db.insertInto("session_reactions").values({
        session_key: sessionKey,
        session_id: params.expectedSessionId,
        message_id: params.messageId,
        emoji: params.emoji,
        identity_id: params.identityId,
        identity_label: params.identityLabel ?? null,
        created_at: Date.now(),
      }),
    );
  }
  return {
    reactions: summarizeReactions(
      executeSqliteQuerySync(
        database.db,
        reactionRows(database, sessionKey, params.expectedSessionId).where(
          "message_id",
          "=",
          params.messageId,
        ),
      ).rows,
    ),
    changed: true,
  };
}

export function listSessionReactionsInDatabase(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  params: { sessionId: string },
): Record<string, StoredMessageReactionSummary[]> {
  const messages = new Map<string, SessionReactions[]>();
  for (const row of executeSqliteQuerySync(
    database.db,
    reactionRows(database, sessionKey, params.sessionId),
  ).rows) {
    const rows = messages.get(row.message_id);
    if (rows) {
      rows.push(row);
    } else {
      messages.set(row.message_id, [row]);
    }
  }
  return Object.fromEntries(
    [...messages].map(([messageId, rows]) => [messageId, summarizeReactions(rows)]),
  );
}
