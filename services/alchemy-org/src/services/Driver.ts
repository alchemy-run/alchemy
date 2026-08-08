/**
 * The org's own DRIVER ASSEMBLY — `AI.DriverCore` composed with the
 * substrate this org wants. The core is the algorithm; every seam is
 * a Layer choice made HERE, in userland:
 *
 * - `SqliteThreadStorage` — threads, observation logs, and run meta
 *   are write-through to sqlite, so a restart restores every
 *   unsettled run parked with its thread primed.
 * - {@link EngineerChats}: the chat projection over sqlite — the UI's
 *   transcript survives the process.
 * - `SqlitePersistentRefStore`: charter `PersistentRef`s survive too
 *   (the driver frames keys per run on the shared store).
 * - `Model` (the org's Anthropic layer) satisfies the LanguageModel
 *   the core samples with.
 *
 * ONE `EngineerChats` instance is provideMerge'd into the entrypoint so
 * the HTTP surface reads the projection the driver writes (layers
 * memoize by reference).
 */
import * as AI from "alchemy/AI";
import { SqliteThreadStorage } from "alchemy/SQLite";
import * as Layer from "effect/Layer";
import { ChatsSqlite } from "./ChatsSqlite.ts";
import { Model } from "./Model.ts";
import { SqlitePersistentRefStore } from "./PersistentRefSqlite.ts";

/** The chat projection — one process, one instance, sqlite-backed. */
export const EngineerChats = ChatsSqlite(".alchemy/engineer-chats.sqlite");

/** The assembled driver: core + sqlite substrate. The observer and
 *  PersistentRef store ride the merge so each AGENT layer's interpret
 *  context finds them. */
export const DriverLocal = Layer.mergeAll(
  AI.DriverLocal.pipe(
    Layer.provide(SqliteThreadStorage(".alchemy/engineer-runs.sqlite")),
    Layer.provide(Model),
  ),
  AI.ChatsObserver.pipe(Layer.provide(EngineerChats)),
  SqlitePersistentRefStore(".alchemy/engineer-state.sqlite"),
);
