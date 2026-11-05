import * as config from "@distilled.cloud/aws/config-service";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeConfigAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `config:DeleteResourceConfig` — delete the recorded
 * configuration of a custom (third-party) resource previously recorded via
 * `PutResourceConfig`.
 *
 * Provide `Config.DeleteResourceConfigHttp` on the hosting Lambda Function to
 * satisfy the requirement.
 * ### Recording Custom Resources
 * **Example:** Delete a Custom Resource's Configuration
 * ```typescript
 * // init — grants config:DeleteResourceConfig
 * const deleteResourceConfig = yield* AWS.Config.DeleteResourceConfig();
 *
 * // runtime
 * yield* deleteResourceConfig({
 *   ResourceType: "MyCompany::Service::Widget",
 *   ResourceId: "widget-1",
 * });
 * ```
 *
 * @binding
 */
export interface DeleteResourceConfig extends Binding.Service<
  DeleteResourceConfig,
  "AWS.Config.DeleteResourceConfig",
  () => Effect.Effect<
    (
      request: config.DeleteResourceConfigRequest,
    ) => Effect.Effect<config.DeleteResourceConfigResponse, config.DeleteResourceConfigError>
  >
> {}

export const DeleteResourceConfig = Binding.Service<DeleteResourceConfig>(
  "AWS.Config.DeleteResourceConfig",
);

export const DeleteResourceConfigHttp = Layer.effect(
  DeleteResourceConfig,
  makeConfigAccountHttpBinding({
    tag: "AWS.Config.DeleteResourceConfig",
    operation: config.deleteResourceConfig,
    actions: ["config:DeleteResourceConfig"],
  }),
);
