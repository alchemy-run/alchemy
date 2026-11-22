import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { DeleteDigitalTwinRelationship } from "./DeleteDigitalTwinRelationship.ts";

/**
 * Implementation of {@link DeleteDigitalTwinRelationship} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsRelationshipDeleteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.DeleteDigitalTwinRelationship
 */
export const DeleteDigitalTwinRelationshipHttp = Layer.effect(
  DeleteDigitalTwinRelationship,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.DeleteDigitalTwinRelationship",
    operation: dt.DeleteDigitalTwinRelationship,
    grant: DigitalTwinsRole.RelationshipDelete,
  }),
);
