import type * as SVC from "@distilled.cloud/aws/emr";
import * as emr from "@distilled.cloud/aws/emr";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEmrAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `elasticmapreduce:ListSupportedInstanceTypes` — lists the EC2 instance types a given EMR release supports in the region.
 * ### Release Catalog
 * **Example:** List Instance Types for a Release
 * ```typescript
 * const listInstanceTypes = yield* AWS.EMR.ListSupportedInstanceTypes();
 *
 * const { SupportedInstanceTypes } = yield* listInstanceTypes({
 *   ReleaseLabel: "emr-7.5.0",
 * });
 * ```
 *
 * @binding
 */
export interface ListSupportedInstanceTypes extends Binding.Service<
  ListSupportedInstanceTypes,
  "AWS.EMR.ListSupportedInstanceTypes",
  () => Effect.Effect<
    (
      request: SVC.ListSupportedInstanceTypesInput,
    ) => Effect.Effect<SVC.ListSupportedInstanceTypesOutput, SVC.ListSupportedInstanceTypesError>
  >
> {}
export const ListSupportedInstanceTypes = Binding.Service<ListSupportedInstanceTypes>(
  "AWS.EMR.ListSupportedInstanceTypes",
);

export const ListSupportedInstanceTypesHttp = Layer.effect(
  ListSupportedInstanceTypes,
  makeEmrAccountHttpBinding({
    tag: "AWS.EMR.ListSupportedInstanceTypes",
    operation: emr.listSupportedInstanceTypes,
    actions: ["elasticmapreduce:ListSupportedInstanceTypes"],
  }),
);
