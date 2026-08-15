import type { Output } from "../../Output.ts";
import type { ApplicationDestination } from "./Application.ts";

/**
 * The slice of a deployed Worker the Access worker destinations need: its
 * immutable script id (`scriptTag`). Structural so both the yielded Worker
 * resource and hand-built shapes satisfy it.
 */
export interface AccessProtectableWorker {
  scriptTag: Output<string | undefined>;
}

/**
 * An {@link ApplicationDestination} whose `workerId` resolves from a deployed
 * Worker's attributes. The discriminant stays a single literal so the
 * destination matches its exact variant of the destination union.
 */
export interface WorkerApplicationDestination<
  Type extends "worker" | "preview_worker",
> {
  type: Type;
  workerId: Output<string>;
}

/**
 * Destination covering a specific Worker's **production** traffic — custom
 * domains, routes, and its `workers.dev` URL.
 *
 * Resolves the Worker's immutable script id (`scriptTag`) — the id the
 * Access API keys on. Note this is NOT the Worker's `workerId` attribute
 * (which carries the script *name*).
 *
 * ```typescript
 * const api = yield* ApiWorker;
 * yield* Cloudflare.Access.Application("ApiAccess", {
 *   type: "self_hosted",
 *   destinations: [Cloudflare.Access.Worker(api)],
 *   policies: [allowTeam.policyId],
 * });
 * ```
 */
export const Worker = (
  worker: AccessProtectableWorker,
): WorkerApplicationDestination<"worker"> => ({
  type: "worker",
  // `scriptTag` is always present after a deploy of the Worker's own script;
  // it is only absent for version workers, which are covered through their
  // parent's tag instead.
  workerId: worker.scriptTag.as<string>(),
});

/**
 * Destination covering a specific Worker's **version preview URLs**
 * (`<version>-<name>.<subdomain>.workers.dev`).
 *
 * ```typescript
 * const api = yield* ApiWorker;
 * yield* Cloudflare.Access.Application("ApiPreviewAccess", {
 *   type: "self_hosted",
 *   destinations: [Cloudflare.Access.WorkerPreview(api)],
 *   policies: [allowTeam.policyId],
 * });
 * ```
 */
export const WorkerPreview = (
  worker: AccessProtectableWorker,
): WorkerApplicationDestination<"preview_worker"> => ({
  type: "preview_worker",
  workerId: worker.scriptTag.as<string>(),
});

/**
 * Destination covering the **production** traffic of every Worker on the
 * account — including Workers created later. Hostname-level policies take
 * precedence over Worker-level policies, which take precedence over this
 * account-level policy, so an individual Worker can still be opened up with
 * its own application.
 *
 * ```typescript
 * yield* Cloudflare.Access.Application("ProtectAllWorkers", {
 *   type: "self_hosted",
 *   destinations: [Cloudflare.Access.AllWorkers],
 *   policies: [allowTeam.policyId],
 * });
 * ```
 */
export const AllWorkers: { type: "all_workers" } = { type: "all_workers" };

/**
 * Destination covering the **version preview URLs** of every Worker on the
 * account — including Workers created later.
 *
 * ```typescript
 * yield* Cloudflare.Access.Application("ProtectAllPreviews", {
 *   type: "self_hosted",
 *   destinations: [Cloudflare.Access.AllWorkerPreviews],
 *   policies: [allowTeam.policyId],
 * });
 * ```
 */
export const AllWorkerPreviews: { type: "all_preview_workers" } = {
  type: "all_preview_workers",
};
