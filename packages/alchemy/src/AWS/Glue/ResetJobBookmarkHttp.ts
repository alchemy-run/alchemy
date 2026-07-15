import * as glue from "@distilled.cloud/aws/glue";
import * as Layer from "effect/Layer";
import { makeGlueJobHttpBinding } from "./BindingHttp.ts";
import { ResetJobBookmark } from "./ResetJobBookmark.ts";

export const ResetJobBookmarkHttp = Layer.effect(
  ResetJobBookmark,
  makeGlueJobHttpBinding({
    tag: "AWS.Glue.ResetJobBookmark",
    operation: glue.resetJobBookmark,
    actions: ["glue:ResetJobBookmark"],
  }),
);
