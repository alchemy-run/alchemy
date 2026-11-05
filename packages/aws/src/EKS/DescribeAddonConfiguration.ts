import * as eks from "@distilled.cloud/aws/eks";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEKSAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `eks:DescribeAddonConfiguration`.
 *
 * Reads an add-on version's configuration JSON schema — the shape its `configurationValues` must satisfy.
 * `eks:DescribeAddonConfiguration` is granted on `*` — the operation is account-scoped and takes no resource.
 * Provide the implementation with
 * `Effect.provide(AWS.EKS.DescribeAddonConfigurationHttp)`.
 * ### Version Catalogs
 * **Example:** Read an Add-on's Configuration Schema
 * ```typescript
 * // init
 * const describeAddonConfiguration =
 *   yield* AWS.EKS.DescribeAddonConfiguration();
 *
 * // runtime
 * const { configurationSchema } = yield* describeAddonConfiguration({
 *   addonName: "vpc-cni",
 *   addonVersion,
 * });
 * ```
 *
 * @binding
 */
export interface DescribeAddonConfiguration extends Binding.Service<
  DescribeAddonConfiguration,
  "AWS.EKS.DescribeAddonConfiguration",
  () => Effect.Effect<
    (
      request: eks.DescribeAddonConfigurationRequest,
    ) => Effect.Effect<eks.DescribeAddonConfigurationResponse, eks.DescribeAddonConfigurationError>
  >
> {}
export const DescribeAddonConfiguration = Binding.Service<DescribeAddonConfiguration>(
  "AWS.EKS.DescribeAddonConfiguration",
);

export const DescribeAddonConfigurationHttp = Layer.effect(
  DescribeAddonConfiguration,
  makeEKSAccountHttpBinding({
    tag: "AWS.EKS.DescribeAddonConfiguration",
    operation: eks.describeAddonConfiguration,
    actions: ["eks:DescribeAddonConfiguration"],
  }),
);
