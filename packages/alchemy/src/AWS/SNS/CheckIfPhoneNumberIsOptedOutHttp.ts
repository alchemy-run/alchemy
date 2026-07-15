import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsAccountHttpBinding } from "./BindingHttp.ts";
import { CheckIfPhoneNumberIsOptedOut } from "./CheckIfPhoneNumberIsOptedOut.ts";

export const CheckIfPhoneNumberIsOptedOutHttp = Layer.effect(
  CheckIfPhoneNumberIsOptedOut,
  makeSnsAccountHttpBinding({
    tag: "AWS.SNS.CheckIfPhoneNumberIsOptedOut",
    operation: sns.checkIfPhoneNumberIsOptedOut,
    actions: ["sns:CheckIfPhoneNumberIsOptedOut"],
  }),
);
