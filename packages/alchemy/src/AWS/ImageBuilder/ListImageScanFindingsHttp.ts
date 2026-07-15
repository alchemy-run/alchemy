import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import * as Layer from "effect/Layer";
import { makeImageBuilderAccountHttpBinding } from "./BindingHttp.ts";
import { ListImageScanFindings } from "./ListImageScanFindings.ts";

export const ListImageScanFindingsHttp = Layer.effect(
  ListImageScanFindings,
  makeImageBuilderAccountHttpBinding({
    tag: "AWS.ImageBuilder.ListImageScanFindings",
    operation: imagebuilder.listImageScanFindings,
    actions: ["imagebuilder:ListImageScanFindings"],
  }),
);
