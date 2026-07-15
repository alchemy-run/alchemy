import * as contacts from "@distilled.cloud/aws/notificationscontacts";
import * as Layer from "effect/Layer";
import { makeEmailContactHttpBinding } from "./BindingHttp.ts";
import { SendActivationCode } from "./SendActivationCode.ts";

export const SendActivationCodeHttp = Layer.effect(
  SendActivationCode,
  makeEmailContactHttpBinding<
    contacts.SendActivationCodeRequest,
    contacts.SendActivationCodeResponse,
    contacts.SendActivationCodeError
  >({
    tag: "AWS.NotificationsContacts.SendActivationCode",
    actions: ["notifications-contacts:SendActivationCode"],
    operation: contacts.sendActivationCode,
  }),
);
