import type * as SVC from "@distilled.cloud/aws/emr";
import * as emr from "@distilled.cloud/aws/emr";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:GetOnClusterAppUIPresignedURL` — mints a presigned URL for a live application UI (Spark UI, YARN ResourceManager, Tez) on the bound cluster.
 * ### Application UIs
 * **Example:** Link to the Spark UI
 * ```typescript
 * const getAppUrl = yield* AWS.EMR.GetOnClusterAppUIPresignedURL(cluster);
 *
 * const { PresignedURL } = yield* getAppUrl({
 *   OnClusterAppUIType: "ApplicationMaster",
 * });
 * ```
 *
 * @binding
 */
export interface GetOnClusterAppUIPresignedURL extends Binding.Service<
  GetOnClusterAppUIPresignedURL,
  "AWS.EMR.GetOnClusterAppUIPresignedURL",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.GetOnClusterAppUIPresignedURLInput, "ClusterId">,
    ) => Effect.Effect<
      SVC.GetOnClusterAppUIPresignedURLOutput,
      SVC.GetOnClusterAppUIPresignedURLError
    >
  >
> {}
export const GetOnClusterAppUIPresignedURL = Binding.Service<GetOnClusterAppUIPresignedURL>(
  "AWS.EMR.GetOnClusterAppUIPresignedURL",
);

export const GetOnClusterAppUIPresignedURLHttp = Layer.effect(
  GetOnClusterAppUIPresignedURL,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.GetOnClusterAppUIPresignedURL",
    operation: emr.getOnClusterAppUIPresignedURL,
    actions: ["elasticmapreduce:GetOnClusterAppUIPresignedURL"],
  }),
);
