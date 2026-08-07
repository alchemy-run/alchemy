/**
 * The kernel seam — the loop that interprets the coder's charter:
 * `AI.KernelMemory` runs as fibers in this process, `remind` on a
 * fiber clock — with the DURABILITY layers that make a restart
 * invisible to the conversation:
 *
 * - {@link CoderChats}: the chat projection over sqlite — the UI's
 *   transcript survives the process.
 * - `SqliteRunJournal`: the kernel journals each run's THREAD at park
 *   and restores it parked at boot — the model's working context
 *   survives the process.
 * - `SqlitePersistentRefStore`: charter `PersistentRef`s survive too
 *   (the kernel frames keys per run on the shared store).
 *
 * ONE `CoderChats` instance is provideMerge'd into the entrypoint so
 * the HTTP surface reads the projection the kernel writes (layers
 * memoize by reference).
 */
import * as AI from "alchemy/AI";
import * as Layer from "effect/Layer";
import { ChatsSqlite } from "./ChatsSqlite.ts";
import { Model } from "./Model.ts";
import { SqlitePersistentRefStore } from "./PersistentRefSqlite.ts";
import { SqliteRunJournal } from "./RunJournalSqlite.ts";

/** The chat projection — one process, one instance, sqlite-backed. */
export const CoderChats = ChatsSqlite(".alchemy/coder-chats.sqlite");

/** KernelMemory reads the observer AND the durability seams from each
 *  AGENT layer's context — merging them beside the kernel puts them
 *  there. */
export const KernelLocal = Layer.mergeAll(
  AI.KernelMemory.pipe(Layer.provide(Model)),
  AI.ChatsObserver.pipe(Layer.provide(CoderChats)),
  SqliteRunJournal(".alchemy/coder-runs.sqlite"),
  SqlitePersistentRefStore(".alchemy/coder-state.sqlite"),
);
