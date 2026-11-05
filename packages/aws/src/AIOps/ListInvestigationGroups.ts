import * as aiops from "@distilled.cloud/aws/aiops";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAIOpsAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `aiops:ListInvestigationGroups`.
 *
 * Enumerates the Region's investigation groups (each item carries the
 * group's name and ARN). An account holds at most one investigation group
 * per Region, so this doubles as an existence probe. Provide the
 * implementation with
 * `Effect.provide(AWS.AIOps.ListInvestigationGroupsHttp)`.
 * ### Listing Investigation Groups
 * **Example:** Discover the Region's Investigation Group
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listInvestigationGroups = yield* AWS.AIOps.ListInvestigationGroups();
 *
 * // runtime
 * const { investigationGroups } = yield* listInvestigationGroups();
 * for (const group of investigationGroups ?? []) {
 *   yield* Effect.log(`${group.name}: ${group.arn}`);
 * }
 * ```
 *
 * @binding
 */
export interface ListInvestigationGroups extends Binding.Service<
  ListInvestigationGroups,
  "AWS.AIOps.ListInvestigationGroups",
  () => Effect.Effect<
    (
      request?: aiops.ListInvestigationGroupsInput,
    ) => Effect.Effect<aiops.ListInvestigationGroupsOutput, aiops.ListInvestigationGroupsError>
  >
> {}
export const ListInvestigationGroups = Binding.Service<ListInvestigationGroups>(
  "AWS.AIOps.ListInvestigationGroups",
);

export const ListInvestigationGroupsHttp = Layer.effect(
  ListInvestigationGroups,
  makeAIOpsAccountHttpBinding({
    tag: "AWS.AIOps.ListInvestigationGroups",
    operation: aiops.listInvestigationGroups,
    actions: ["aiops:ListInvestigationGroups"],
  }),
);
