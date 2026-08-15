import * as AI from "alchemy/AI";
import { ThreadStorageSqlite } from "alchemy/SQLite";
import * as Layer from "effect/Layer";
import { Model } from "./Model.ts";
import { SqlitePersistentRefStore } from "./PersistentRefSqlite.ts";
import { SessionIndexSqlite } from "./SessionIndexSqlite.ts";

/**
 * The session storage — threads, inbox, observation logs, meta are
 * write-through to sqlite, so a restart restores every unsettled
 * session parked with its thread primed. ONE instance (layers memoize
 * by reference): the driver writes through it and the HTTP surface
 * reads transcripts from it.
 */
export const EngineerStorage = ThreadStorageSqlite(
  ".alchemy/engineer-sessions.sqlite",
);

/** The session directory — the board the UI lists, sqlite-backed. */
export const EngineerIndex = SessionIndexSqlite(
  ".alchemy/engineer-index.sqlite",
);

/**
 * The org's DRIVER ASSEMBLY — the loop over this org's substrate
 * choices, every seam a Layer decision made HERE, in userland:
 * sqlite storage + the Anthropic `LanguageModel` + the session index
 * riding the event stream + durable charter refs.
 */
export const DriverLocal = Layer.mergeAll(
  AI.DriverLocal.pipe(
    Layer.provideMerge(EngineerStorage),
    Layer.provide(Model),
    // the driver's `Sessions.list` delegates to the index
    Layer.provide(EngineerIndex),
  ),
  // provideMERGE: the HTTP surface reads the index the stream writes
  AI.SessionIndexStream.pipe(Layer.provideMerge(EngineerIndex)),
  SqlitePersistentRefStore(".alchemy/engineer-state.sqlite"),
);
