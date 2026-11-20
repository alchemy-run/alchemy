import type * as SVC from "@distilled.cloud/aws/emr";
import * as emr from "@distilled.cloud/aws/emr";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEmrClusterHttpBinding } from "./BindingHttp.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for `elasticmapreduce:DescribePersistentAppUI` — reads a persistent application UI created for the bound cluster by {@link CreatePersistentAppUI}.
 * ### Application UIs
 * **Example:** Wait for the UI to Attach
 * ```typescript
 * const describeAppUI = yield* AWS.EMR.DescribePersistentAppUI(cluster);
 *
 * const { PersistentAppUI } = yield* describeAppUI({
 *   PersistentAppUIId: appUIId,
 * });
 * ```
 *
 * @binding
 */
export interface DescribePersistentAppUI extends Binding.Service<
  DescribePersistentAppUI,
  "AWS.EMR.DescribePersistentAppUI",
  <C extends Cluster>(
    cluster: C,
  ) => Effect.Effect<
    (
      request: SVC.DescribePersistentAppUIInput,
    ) => Effect.Effect<SVC.DescribePersistentAppUIOutput, SVC.DescribePersistentAppUIError>
  >
> {}
export const DescribePersistentAppUI = Binding.Service<DescribePersistentAppUI>(
  "AWS.EMR.DescribePersistentAppUI",
);

export const DescribePersistentAppUIHttp = Layer.effect(
  DescribePersistentAppUI,
  makeEmrClusterHttpBinding({
    tag: "AWS.EMR.DescribePersistentAppUI",
    operation: emr.describePersistentAppUI,
    actions: ["elasticmapreduce:DescribePersistentAppUI"],
    inject: "none",
  }),
);
