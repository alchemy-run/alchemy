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
 * listening. {@link OrgChats} / {@link OrgChatsWorker} is ONE instance
 * provideMerge'd into the entrypoint so the HTTP surface reads the
 * projection the kernel writes (layers memoize by reference).
 *
 * Locally that is `ChatsMemory` (one process). On Cloudflare it is
 * `ChatsCloudflare` — a singleton Durable Object every run DO RPCs
 * into, so the Worker's `/api/board` sees admissions across isolates.
 */
import * as AI from "alchemy/AI";
import * as CloudflareAI from "alchemy/Cloudflare/AI";
import * as Layer from "effect/Layer";
import { Model } from "./Model.ts";

/** Local / test projection — one process. */
export const OrgChats = AI.ChatsMemory();

/** Cloudflare projection — singleton OrgChats DO. */
export const OrgChatsWorker = CloudflareAI.ChatsCloudflare;

const ObserverLocal = AI.ChatsObserver.pipe(Layer.provide(OrgChats));
const ObserverWorker = AI.ChatsObserver.pipe(Layer.provide(OrgChatsWorker));

/** KernelMemory reads the observer from each AGENT layer's context —
 *  merging it beside the kernel puts it there. */
export const KernelLocal = Layer.mergeAll(
  AI.KernelMemory.pipe(Layer.provide(Model)),
  ObserverLocal,
);

/** KernelCloudflare captures the observer at ITS OWN build (the
 *  Durable Objects resolve it from the kernel layer's context), so it
 *  is provided INWARD as well as merged out for the agents. */
export const KernelWorker = Layer.mergeAll(
  CloudflareAI.KernelCloudflare.pipe(
    Layer.provide(Model),
    Layer.provideMerge(ObserverWorker),
  ),
);
