import * as account from "@distilled.cloud/aws/account";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `account:GetContactInformation`.
 *
 * Reads the calling account's primary contact — full name, address, phone
 * number, and company. The contact fields are marked sensitive at the wire
 * level, so distilled returns them as `string | Redacted<string>`. Account
 * Management is an account singleton, so the binding takes no resource
 * argument. Provide the implementation with
 * `Effect.provide(AWS.Account.GetContactInformationHttp)`.
 * ### Reading Account Settings
 * **Example:** Read the Primary Contact
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getContactInformation = yield* AWS.Account.GetContactInformation();
 *
 * // runtime
 * const { ContactInformation } = yield* getContactInformation();
 * console.log(ContactInformation?.CountryCode);
 * ```
 *
 * @binding
 */
export interface GetContactInformation extends Binding.Service<
  GetContactInformation,
  "AWS.Account.GetContactInformation",
  () => Effect.Effect<
    (
      request?: account.GetContactInformationRequest,
    ) => Effect.Effect<account.GetContactInformationResponse, account.GetContactInformationError>
  >
> {}
export const GetContactInformation = Binding.Service<GetContactInformation>(
  "AWS.Account.GetContactInformation",
);

export const GetContactInformationHttp = Layer.effect(
  GetContactInformation,
  makeAccountHttpBinding({
    capability: "GetContactInformation",
    iamActions: ["account:GetContactInformation"],
    operation: account.getContactInformation,
  }),
);
