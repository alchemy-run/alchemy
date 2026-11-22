import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { ListDigitalTwinRelationships } from "./ListDigitalTwinRelationships.ts";

/**
 * Implementation of {@link ListDigitalTwinRelationships} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsRelationshipReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.ListDigitalTwinRelationships
 */
export const ListDigitalTwinRelationshipsHttp = Layer.effect(
  ListDigitalTwinRelationships,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.ListDigitalTwinRelationships",
    operation: dt.ListDigitalTwinRelationships,
    grant: DigitalTwinsRole.RelationshipRead,
  }),
);
