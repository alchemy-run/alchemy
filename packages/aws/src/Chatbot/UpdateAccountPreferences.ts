import * as chatbot from "@distilled.cloud/aws/chatbot";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeChatbotAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `chatbot:UpdateAccountPreferences`.
 *
 * Updates the account-level AWS Chatbot preferences (user-level
 * authorization requirement, training-data collection). Provide the
 * implementation with
 * `Effect.provide(AWS.Chatbot.UpdateAccountPreferencesHttp)`.
 * ### Account Preferences
 * **Example:** Require user authorization account-wide
 * ```typescript
 * const updateAccountPreferences =
 *   yield* AWS.Chatbot.UpdateAccountPreferences();
 * yield* updateAccountPreferences({ UserAuthorizationRequired: true });
 * ```
 *
 * @binding
 */
export interface UpdateAccountPreferences extends Binding.Service<
  UpdateAccountPreferences,
  "AWS.Chatbot.UpdateAccountPreferences",
  () => Effect.Effect<
    (
      request?: chatbot.UpdateAccountPreferencesRequest,
    ) => Effect.Effect<
      chatbot.UpdateAccountPreferencesResult,
      chatbot.UpdateAccountPreferencesError
    >
  >
> {}

export const UpdateAccountPreferences = Binding.Service<UpdateAccountPreferences>(
  "AWS.Chatbot.UpdateAccountPreferences",
);

export const UpdateAccountPreferencesHttp = Layer.effect(
  UpdateAccountPreferences,
  makeChatbotAccountHttpBinding({
    tag: "AWS.Chatbot.UpdateAccountPreferences",
    operation: chatbot.updateAccountPreferences,
    actions: ["chatbot:UpdateAccountPreferences"],
  }),
);
