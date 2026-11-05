import * as aoss from "@distilled.cloud/aws/opensearchserverless";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAossAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for the `GetAccountSettings` operation (IAM action
 * `aoss:GetAccountSettings`; the action does not support resource-level
 * scoping, so the grant is on `*`).
 *
 * Reads the account-level OpenSearch Serverless settings — the OCU capacity
 * limits that cap the account's spend. Provide the implementation with
 * `Effect.provide(AWS.OpenSearchServerless.GetAccountSettingsHttp)`.
 * ### Account Settings
 * **Example:** Read the account's OCU capacity limits
 * ```typescript
 * const getAccountSettings = yield* AWS.OpenSearchServerless.GetAccountSettings();
 *
 * const settings = yield* getAccountSettings();
 * const limits = settings.accountSettingsDetail?.capacityLimits;
 * yield* Effect.log(`max indexing OCUs: ${limits?.maxIndexingCapacityInOCU}`);
 * ```
 *
 * @binding
 */
export interface GetAccountSettings extends Binding.Service<
  GetAccountSettings,
  "AWS.OpenSearchServerless.GetAccountSettings",
  () => Effect.Effect<
    (
      request?: aoss.GetAccountSettingsRequest,
    ) => Effect.Effect<aoss.GetAccountSettingsResponse, aoss.GetAccountSettingsError>
  >
> {}
export const GetAccountSettings = Binding.Service<GetAccountSettings>(
  "AWS.OpenSearchServerless.GetAccountSettings",
);

export const GetAccountSettingsHttp = Layer.effect(
  GetAccountSettings,
  makeAossAccountHttpBinding({
    tag: "AWS.OpenSearchServerless.GetAccountSettings",
    operation: aoss.getAccountSettings,
    actions: ["aoss:GetAccountSettings"],
  }),
);
