import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `inspector2:UpdateOrganizationConfiguration`.
 *
 * Updates the configurations for your Amazon Inspector organization.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.UpdateOrganizationConfigurationHttp)`.
 * ### Organization & Members
 * **Example:** Auto-Enable Scanning for New Members
 * ```typescript
 * // init
 * const updateOrganizationConfiguration = yield* AWS.Inspector2.UpdateOrganizationConfiguration();
 *
 * // runtime
 * yield* updateOrganizationConfiguration({
 *   autoEnable: { ec2: true, ecr: true, lambda: true },
 * });
 * ```
 *
 * @binding
 */
export interface UpdateOrganizationConfiguration extends Binding.Service<
  UpdateOrganizationConfiguration,
  "AWS.Inspector2.UpdateOrganizationConfiguration",
  () => Effect.Effect<
    (
      request: inspector2.UpdateOrganizationConfigurationRequest,
    ) => Effect.Effect<
      inspector2.UpdateOrganizationConfigurationResponse,
      inspector2.UpdateOrganizationConfigurationError
    >
  >
> {}
export const UpdateOrganizationConfiguration = Binding.Service<UpdateOrganizationConfiguration>(
  "AWS.Inspector2.UpdateOrganizationConfiguration",
);

export const UpdateOrganizationConfigurationHttp = Layer.effect(
  UpdateOrganizationConfiguration,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.UpdateOrganizationConfiguration",
    operation: inspector2.updateOrganizationConfiguration,
    actions: ["inspector2:UpdateOrganizationConfiguration"],
  }),
);
