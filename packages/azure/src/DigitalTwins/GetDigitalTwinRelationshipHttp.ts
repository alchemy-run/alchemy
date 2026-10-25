import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { GetDigitalTwinRelationship } from "./GetDigitalTwinRelationship.ts";

/**
 * Implementation of {@link GetDigitalTwinRelationship} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsRelationshipReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.GetDigitalTwinRelationship
 */
export const GetDigitalTwinRelationshipHttp = Layer.effect(
  GetDigitalTwinRelationship,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.GetDigitalTwinRelationship",
    operation: dt.GetDigitalTwinRelationshipById,
    grant: DigitalTwinsRole.RelationshipRead,
  }),
);
