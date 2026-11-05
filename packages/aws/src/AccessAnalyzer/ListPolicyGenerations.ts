import * as aa from "@distilled.cloud/aws/accessanalyzer";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAccessAnalyzerAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `access-analyzer:ListPolicyGenerations`.
 *
 * Lists the account's recent policy-generation jobs. Provide the
 * implementation with
 * `Effect.provide(AWS.AccessAnalyzer.ListPolicyGenerationsHttp)`.
 * ### Policy Generation
 * **Example:** List Policy Generations
 * ```typescript
 * const listGenerations =
 *   yield* AWS.AccessAnalyzer.ListPolicyGenerations();
 * const page = yield* listGenerations();
 * ```
 *
 * @binding
 */
export interface ListPolicyGenerations extends Binding.Service<
  ListPolicyGenerations,
  "AWS.AccessAnalyzer.ListPolicyGenerations",
  () => Effect.Effect<
    (
      request?: aa.ListPolicyGenerationsRequest,
    ) => Effect.Effect<aa.ListPolicyGenerationsResponse, aa.ListPolicyGenerationsError>
  >
> {}

export const ListPolicyGenerations = Binding.Service<ListPolicyGenerations>(
  "AWS.AccessAnalyzer.ListPolicyGenerations",
);

export const ListPolicyGenerationsHttp = Layer.effect(
  ListPolicyGenerations,
  makeAccessAnalyzerAccountHttpBinding({
    tag: "AWS.AccessAnalyzer.ListPolicyGenerations",
    operation: aa.listPolicyGenerations,
    actions: ["access-analyzer:ListPolicyGenerations"],
  }),
);
