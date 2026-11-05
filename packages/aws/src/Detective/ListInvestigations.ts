import * as detective from "@distilled.cloud/aws/detective";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeDetectiveGraphHttpBinding } from "./BindingHttp.ts";
import type { Graph } from "./Graph.ts";

/**
 * Runtime binding for `detective:ListInvestigations`.
 *
 * Enumerates the behavior graph's investigations with optional filter and
 * sort criteria — list everything triaged in the last week, or every
 * investigation still `ACTIVE`. The graph ARN is injected from the bound
 * {@link Graph}.
 * Provide the implementation with
 * `Effect.provide(AWS.Detective.ListInvestigationsHttp)`.
 * ### Running Investigations
 * **Example:** List Active Investigations
 * ```typescript
 * // init
 * const listInvestigations = yield* AWS.Detective.ListInvestigations(graph);
 *
 * // runtime
 * const { InvestigationDetails } = yield* listInvestigations();
 * ```
 *
 * @binding
 */
export interface ListInvestigations extends Binding.Service<
  ListInvestigations,
  "AWS.Detective.ListInvestigations",
  (
    graph: Graph,
  ) => Effect.Effect<
    (
      request?: Omit<detective.ListInvestigationsRequest, "GraphArn">,
    ) => Effect.Effect<detective.ListInvestigationsResponse, detective.ListInvestigationsError>
  >
> {}
export const ListInvestigations = Binding.Service<ListInvestigations>(
  "AWS.Detective.ListInvestigations",
);

export const ListInvestigationsHttp = Layer.effect(
  ListInvestigations,
  makeDetectiveGraphHttpBinding({
    tag: "AWS.Detective.ListInvestigations",
    operation: detective.listInvestigations,
    actions: ["detective:ListInvestigations"],
  }),
);
