import * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import * as Layer from "effect/Layer";
import { makeImageBuilderAccountHttpBinding } from "./BindingHttp.ts";
import { ListImageScanFindingAggregations } from "./ListImageScanFindingAggregations.ts";

export const ListImageScanFindingAggregationsHttp = Layer.effect(
  ListImageScanFindingAggregations,
  makeImageBuilderAccountHttpBinding({
    tag: "AWS.ImageBuilder.ListImageScanFindingAggregations",
    operation: imagebuilder.listImageScanFindingAggregations,
    actions: ["imagebuilder:ListImageScanFindingAggregations"],
  }),
);
