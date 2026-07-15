import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsAccountHttpBinding } from "./BindingHttp.ts";
import { GetSMSAttributes } from "./GetSMSAttributes.ts";

export const GetSMSAttributesHttp = Layer.effect(
  GetSMSAttributes,
  makeSnsAccountHttpBinding({
    tag: "AWS.SNS.GetSMSAttributes",
    operation: sns.getSMSAttributes,
    actions: ["sns:GetSMSAttributes"],
  }),
);
