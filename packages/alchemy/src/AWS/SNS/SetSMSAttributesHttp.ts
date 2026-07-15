import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsAccountHttpBinding } from "./BindingHttp.ts";
import { SetSMSAttributes } from "./SetSMSAttributes.ts";

export const SetSMSAttributesHttp = Layer.effect(
  SetSMSAttributes,
  makeSnsAccountHttpBinding({
    tag: "AWS.SNS.SetSMSAttributes",
    operation: sns.setSMSAttributes,
    actions: ["sns:SetSMSAttributes"],
  }),
);
