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
 * ```typescript
 * const api = yield* ApiWorker;
 * yield* Cloudflare.Access.Application("ApiAccess", {
 *   type: "self_hosted",
 *   destinations: [Cloudflare.Access.worker(api)],
 *   policies: [allowTeam.policyId],
 * });
 * ```
 */
export const worker = (
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
 *   destinations: [Cloudflare.Access.previewWorker(api)],
 *   policies: [allowTeam.policyId],
 * });
 * ```
 */
export const previewWorker = (
  worker: AccessProtectableWorker,
): WorkerApplicationDestination<"preview_worker"> => ({
  type: "preview_worker",
  workerId: worker.scriptTag.as<string>(),
});
