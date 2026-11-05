import * as macie2 from "@distilled.cloud/aws/macie2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeMacie2HttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `macie2:PutFindingsPublicationConfiguration`.
 *
 * Updates the configuration settings for publishing findings to Security Hub.
 * Account-level operation — invoked with the caller's request as-is.
 * Provide the implementation with
 * `Effect.provide(AWS.Macie2.PutFindingsPublicationConfigurationHttp)`.
 * ### Publishing Findings
 * **Example:** Publish Policy Findings to Security Hub
 * ```typescript
 * // init — account-level binding, no resource argument
 * const putFindingsPublicationConfiguration = yield* AWS.Macie2.PutFindingsPublicationConfiguration();
 *
 * // runtime
 * yield* putFindingsPublicationConfiguration({
 *   securityHubConfiguration: {
 *     publishClassificationFindings: false,
 *     publishPolicyFindings: true,
 *   },
 * });
 * ```
 *
 * @binding
 */
export interface PutFindingsPublicationConfiguration extends Binding.Service<
  PutFindingsPublicationConfiguration,
  "AWS.Macie2.PutFindingsPublicationConfiguration",
  () => Effect.Effect<
    (
      request?: macie2.PutFindingsPublicationConfigurationRequest,
    ) => Effect.Effect<
      macie2.PutFindingsPublicationConfigurationResponse,
      macie2.PutFindingsPublicationConfigurationError
    >
  >
> {}
export const PutFindingsPublicationConfiguration =
  Binding.Service<PutFindingsPublicationConfiguration>(
    "AWS.Macie2.PutFindingsPublicationConfiguration",
  );

export const PutFindingsPublicationConfigurationHttp = Layer.effect(
  PutFindingsPublicationConfiguration,
  makeMacie2HttpBinding({
    tag: "AWS.Macie2.PutFindingsPublicationConfiguration",
    operation: macie2.putFindingsPublicationConfiguration,
    actions: ["macie2:PutFindingsPublicationConfiguration"],
  }),
);
