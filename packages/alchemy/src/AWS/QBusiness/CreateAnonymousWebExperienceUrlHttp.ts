import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Layer from "effect/Layer";
import { makeQBusinessWebExperienceHttpBinding } from "./BindingHttp.ts";
import { CreateAnonymousWebExperienceUrl } from "./CreateAnonymousWebExperienceUrl.ts";

export const CreateAnonymousWebExperienceUrlHttp = Layer.effect(
  CreateAnonymousWebExperienceUrl,
  makeQBusinessWebExperienceHttpBinding({
    tag: "AWS.QBusiness.CreateAnonymousWebExperienceUrl",
    operation: qbusiness.createAnonymousWebExperienceUrl,
    actions: ["qbusiness:CreateAnonymousWebExperienceUrl"],
  }),
);
