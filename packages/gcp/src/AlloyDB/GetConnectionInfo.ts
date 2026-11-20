import * as alloydb from "@distilled.cloud/gcp/alloydb_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAlloyDbConnectionInfoHttpBinding } from "./BindingHttp.ts";
import type { Instance } from "./Instance.ts";

export interface GetConnectionInfoRequest extends Omit<
  alloydb.GetConnectionInfoProjectsLocationsClustersInstancesRequest,
  "parent"
> {}

/**
 * Runtime binding for AlloyDB `instances.getConnectionInfo`.
 *
 * Bind this operation to an {@link Instance} in a Function/Action init
 * phase. Provide {@link GetConnectionInfoHttp}.
 *
 * ### Connection Info
 * **Example:** Read private and public IPs
 * ```typescript
 * const getConnectionInfo = yield* GCP.AlloyDB.GetConnectionInfo(primary);
 * const info = yield* getConnectionInfo();
 * ```
 *
 * @binding
 * @category AlloyDB
 */
export interface GetConnectionInfo extends Binding.Service<
  GetConnectionInfo,
  "GCP.AlloyDB.GetConnectionInfo",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: GetConnectionInfoRequest,
    ) => Effect.Effect<
      alloydb.ConnectionInfo,
      alloydb.GetConnectionInfoProjectsLocationsClustersInstancesError,
      RuntimeContext
    >
  >
> {}

export const GetConnectionInfo = Binding.Service<GetConnectionInfo>(
  "GCP.AlloyDB.GetConnectionInfo",
);

/**
 * HTTP implementation of {@link GetConnectionInfo}.
 *
 * @layer
 * @provides GCP.AlloyDB.GetConnectionInfo
 */
export const GetConnectionInfoHttp = Layer.effect(
  GetConnectionInfo,
  makeAlloyDbConnectionInfoHttpBinding({
    tag: "GCP.AlloyDB.GetConnectionInfo",
    iam: { role: "roles/alloydb.client" },
    operation: alloydb.getConnectionInfoProjectsLocationsClustersInstances,
  }),
);
