import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsAccountHttpBinding } from "./BindingHttp.ts";
import { OptInPhoneNumber } from "./OptInPhoneNumber.ts";

export const OptInPhoneNumberHttp = Layer.effect(
  OptInPhoneNumber,
  makeSnsAccountHttpBinding({
    tag: "AWS.SNS.OptInPhoneNumber",
    operation: sns.optInPhoneNumber,
    actions: ["sns:OptInPhoneNumber"],
  }),
);
