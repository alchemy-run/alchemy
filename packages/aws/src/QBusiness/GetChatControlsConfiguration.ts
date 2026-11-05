import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Application } from "./Application.ts";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";

/**
 * `GetChatControlsConfiguration` request with `applicationId` injected from the bound application.
 */
export interface GetChatControlsConfigurationRequest extends Omit<
  qbusiness.GetChatControlsConfigurationRequest,
  "applicationId"
> {}

/**
 * Runtime binding for the `GetChatControlsConfiguration` operation (IAM action
 * `qbusiness:GetChatControlsConfiguration`), scoped to one {@link Application}.
 *
 * Reads the application's chat controls: response scope, blocked
 * phrases, topic rules, and creator mode.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.GetChatControlsConfigurationHttp)`.
 *
 * ### Admin Controls
 * **Example:** Read Chat Controls
 * ```typescript
 * const getControls = yield* AWS.QBusiness.GetChatControlsConfiguration(app);
 *
 * const { responseScope, blockedPhrases } = yield* getControls();
 * ```
 *
 * @binding
 */
export interface GetChatControlsConfiguration extends Binding.Service<
  GetChatControlsConfiguration,
  "AWS.QBusiness.GetChatControlsConfiguration",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request?: GetChatControlsConfigurationRequest,
    ) => Effect.Effect<
      qbusiness.GetChatControlsConfigurationResponse,
      qbusiness.GetChatControlsConfigurationError
    >
  >
> {}
export const GetChatControlsConfiguration = Binding.Service<GetChatControlsConfiguration>(
  "AWS.QBusiness.GetChatControlsConfiguration",
);

export const GetChatControlsConfigurationHttp = Layer.effect(
  GetChatControlsConfiguration,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.GetChatControlsConfiguration",
    operation: qbusiness.getChatControlsConfiguration,
    actions: ["qbusiness:GetChatControlsConfiguration"],
  }),
);
