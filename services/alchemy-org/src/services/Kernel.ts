/**
 * The kernel seam — the loop that interprets the bot's charter:
 * `AI.KernelMemory` runs as fibers in this process, parked threads
 * held in memory, `remind` on a fiber clock.
 *
 * It carries the OBSERVABILITY seam: the kernel interprets its runs
 * with the chat projection listening. {@link BotChats} is ONE
 * instance provideMerge'd into the entrypoint so the HTTP surface
 * reads the projection the kernel writes (layers memoize by
 * reference).
 */
import * as AI from "alchemy/AI";
import * as Layer from "effect/Layer";
import { Model } from "./Model.ts";

/** The chat projection — one process, one instance. */
export const BotChats = AI.ChatsMemory();

/** KernelMemory reads the observer from each AGENT layer's context —
 *  merging it beside the kernel puts it there. */
export const KernelLocal = Layer.mergeAll(
  AI.KernelMemory.pipe(Layer.provide(Model)),
  AI.ChatsObserver.pipe(Layer.provide(BotChats)),
);
