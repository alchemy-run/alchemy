/**
 * The kernel seam — which loop interprets the org's charters:
 *
 * - {@link KernelLocal} — `AI.KernelMemory`: runs as fibers in the org
 *   process, parked runs held in memory, `remind` on a fiber clock.
 * - {@link KernelWorker} — `Cloudflare.AI.KernelCloudflare`: one
 *   Durable Object per run, threads in DO storage, recovery by alarm,
 *   and the run-socket live view (`AI.AgentGateway` comes WITH it).
 *
 * Both carry the OBSERVABILITY seam: every agent layer that provides
 * this bundle interprets its runs with the org's chat projection
 * listening. {@link OrgChats} is ONE instance — the same const is
 * provideMerge'd into the entrypoint composition so the HTTP surface
 * reads the projection the kernel writes (layers memoize by
 * reference). On the Worker the projection is PER-ISOLATE (best
 * effort for the board); the durable per-run view is the run socket.
 */
import * as AI from "alchemy/AI";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Layer from "effect/Layer";
import { Model } from "./Model.ts";

export const OrgChats = AI.ChatsMemory();

const Observer = AI.ChatsObserver.pipe(Layer.provide(OrgChats));

/** KernelMemory reads the observer from each AGENT layer's context —
 *  merging it beside the kernel puts it there. */
export const KernelLocal = Layer.mergeAll(
  AI.KernelMemory.pipe(Layer.provide(Model)),
  Observer,
);

/** KernelCloudflare captures the observer at ITS OWN build (the
 *  Durable Objects resolve it from the kernel layer's context), so it
 *  is provided INWARD as well as merged out for the agents. */
export const KernelWorker = Layer.mergeAll(
  Cloudflare.AI.KernelCloudflare.pipe(
    Layer.provide(Model),
    Layer.provideMerge(Observer),
  ),
);
