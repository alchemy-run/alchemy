import * as mediaconvert from "@distilled.cloud/aws/mediaconvert";
import * as Layer from "effect/Layer";
import { makeMediaConvertHttpBinding } from "./BindingHttp.ts";
import { StartJobsQuery } from "./StartJobsQuery.ts";

export const StartJobsQueryHttp = Layer.effect(
  StartJobsQuery,
  makeMediaConvertHttpBinding({
    capability: "StartJobsQuery",
    iamActions: ["mediaconvert:StartJobsQuery"],
    operation: mediaconvert.startJobsQuery,
  }),
);
