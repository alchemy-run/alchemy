import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { UpdateDigitalTwinRelationship } from "./UpdateDigitalTwinRelationship.ts";

/**
 * Implementation of {@link UpdateDigitalTwinRelationship} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsRelationshipWriteRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.UpdateDigitalTwinRelationship
 */
export const UpdateDigitalTwinRelationshipHttp = Layer.effect(
  UpdateDigitalTwinRelationship,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.UpdateDigitalTwinRelationship",
    operation: dt.UpdateDigitalTwinRelationship,
    grant: DigitalTwinsRole.RelationshipWrite,
  }),
);
