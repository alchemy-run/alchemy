import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { AddDigitalTwinRelationship } from "./AddDigitalTwinRelationship.ts";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";

/**
 * Implementation of {@link AddDigitalTwinRelationship} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsRelationshipWriteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.AddDigitalTwinRelationship
 */
export const AddDigitalTwinRelationshipHttp = Layer.effect(
  AddDigitalTwinRelationship,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.AddDigitalTwinRelationship",
    operation: dt.AddDigitalTwinRelationship,
    grant: DigitalTwinsRole.RelationshipWrite,
  }),
);
