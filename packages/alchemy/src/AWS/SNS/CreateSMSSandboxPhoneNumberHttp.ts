import * as sns from "@distilled.cloud/aws/sns";
import * as Layer from "effect/Layer";
import { makeSnsAccountHttpBinding } from "./BindingHttp.ts";
import { CreateSMSSandboxPhoneNumber } from "./CreateSMSSandboxPhoneNumber.ts";

export const CreateSMSSandboxPhoneNumberHttp = Layer.effect(
  CreateSMSSandboxPhoneNumber,
  makeSnsAccountHttpBinding({
    tag: "AWS.SNS.CreateSMSSandboxPhoneNumber",
    operation: sns.createSMSSandboxPhoneNumber,
    actions: ["sns:CreateSMSSandboxPhoneNumber"],
  }),
);
