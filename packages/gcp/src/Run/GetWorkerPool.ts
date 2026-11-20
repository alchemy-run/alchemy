import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import type { WorkerPool } from "./WorkerPool.ts";

export interface GetWorkerPoolRequest extends Omit<
  cloudrun.GetProjectsLocationsWorkerPoolsRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Run `workerPools.get`.
 *
 * Bind this operation to a {@link WorkerPool} in a Function/Action init
 * phase. Provide {@link GetWorkerPoolHttp}.
 *
 * ### Reading a Worker Pool
 * **Example:** Get the bound worker pool
 * ```typescript
 * const getWorkerPool = yield* GCP.Run.GetWorkerPool(pool);
 * const live = yield* getWorkerPool();
 * ```
 *
 * @binding
 * @category Run
 */
export interface GetWorkerPool extends Binding.Service<
  GetWorkerPool,
  "GCP.Run.GetWorkerPool",
  (
    pool: WorkerPool,
  ) => Effect.Effect<
    (
      request?: GetWorkerPoolRequest,
    ) => Effect.Effect<
      cloudrun.GoogleCloudRunV2WorkerPool,
      cloudrun.GetProjectsLocationsWorkerPoolsError,
      RuntimeContext
    >
  >
> {}

export const GetWorkerPool = Binding.Service<GetWorkerPool>("GCP.Run.GetWorkerPool");

/**
 * HTTP implementation of {@link GetWorkerPool}.
 *
 * @layer
 * @provides GCP.Run.GetWorkerPool
 */
export const GetWorkerPoolHttp = Layer.effect(
  GetWorkerPool,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const getProjectsLocationsWorkerPools = yield* GCPBindings.withCredentials(
      cloudrun.getProjectsLocationsWorkerPools,
    );
    return Effect.fn(function* <T extends WorkerPool>(pool: T) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.Run.GetWorkerPool(${pool})`({
          iam: [grantFor({ role: "roles/run.viewer", on: "run.workerPool" }, pool.name)],
        });
      }
      const name = yield* pool.name;
      return Effect.fn(`GCP.Run.GetWorkerPool(${pool.LogicalId})`)(function* (
        request?: GetWorkerPoolRequest,
      ) {
        return yield* getProjectsLocationsWorkerPools({
          ...request,
          name: yield* name,
        });
      });
    });
  }),
);
