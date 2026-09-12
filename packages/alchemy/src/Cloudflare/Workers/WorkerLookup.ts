import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";

import * as Output from "../../Output.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { WorkerTypeId } from "./Worker.ts";

export type WorkerLookupProps = {
  /**
   * Deployed script name of the Worker.
   */
  name: string;
};

/**
 * The resolved value of a {@link lookup} — the external Worker's identifying
 * attributes branded with the Worker resource `Type`, so Worker binding
 * classification treats it exactly like a managed Worker.
 */
export interface WorkerLookup {
  readonly Type: typeof WorkerTypeId;
  readonly workerId: string;
  readonly workerName: string;
  readonly accountId: string;
}

/**
 * Look up an existing Cloudflare Worker (managed outside this stack) without
 * managing its lifecycle — the data-source form (what Terraform calls a data
 * source and Pulumi an invoke). Reads the script by `name` and returns an
 * `Output` of its identifying attributes, resolved during plan/deploy and
 * inert inside deployed bundles. Place it in a Worker's `env` to attach a
 * `service` binding.
 *
 * Fails the deploy when no Worker of that name exists on the account. The
 * target is never created, updated, or deleted by this stack.
 * @resource
 * @product Workers
 * @category Workers & Compute
 * @section Referencing an External Worker
 * @example Look up by name
 * ```typescript
 * const auth = Cloudflare.Worker.lookup({ name: "auth-service" });
 * ```
 *
 * @example Bind to a Worker
 * ```typescript
 * const worker = yield* Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: { AUTH: Cloudflare.Worker.lookup({ name: "auth-service" }) },
 * });
 * ```
 */
export const lookup = (props: WorkerLookupProps) =>
  Output.fromEffect(
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Fails with `WorkerNotFound` when the script doesn't exist — the
      // existence check, without pulling down the script content.
      yield* workers
        .getScriptScriptAndVersionSetting({ accountId, scriptName: props.name })
        .pipe(
          Effect.catchTag("WorkerNotFound", () =>
            Effect.die(`Worker "${props.name}" not found`),
          ),
        );
      // A Worker's script name is its id.
      return {
        Type: WorkerTypeId,
        workerId: props.name,
        workerName: props.name,
        accountId,
      } satisfies WorkerLookup;
    }).pipe(Effect.orDie),
  );
