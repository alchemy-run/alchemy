import type * as SVC from "@distilled.cloud/aws/finspace";
import * as finspace from "@distilled.cloud/aws/finspace";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:ListKxScalingGroups` — lists the scaling groups of the bound environment.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.ListKxScalingGroupsHttp)`.
 * ### Managing Scaling Groups
 * **Example:** List Scaling Groups
 * ```typescript
 * const listScalingGroups = yield* AWS.FinSpace.ListKxScalingGroups(kdb);
 *
 * const { scalingGroups } = yield* listScalingGroups();
 * ```
 *
 * @binding
 */
export interface ListKxScalingGroups extends Binding.Service<
  ListKxScalingGroups,
  "AWS.FinSpace.ListKxScalingGroups",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.ListKxScalingGroupsRequest, "environmentId">,
    ) => Effect.Effect<SVC.ListKxScalingGroupsResponse, SVC.ListKxScalingGroupsError>
  >
> {}
export const ListKxScalingGroups = Binding.Service<ListKxScalingGroups>(
  "AWS.FinSpace.ListKxScalingGroups",
);

export const ListKxScalingGroupsHttp = Layer.effect(
  ListKxScalingGroups,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.ListKxScalingGroups",
    operation: finspace.listKxScalingGroups,
    actions: ["finspace:ListKxScalingGroups"],
  }),
);
