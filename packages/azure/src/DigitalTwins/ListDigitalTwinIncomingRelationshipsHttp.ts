import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { ListDigitalTwinIncomingRelationships } from "./ListDigitalTwinIncomingRelationships.ts";

/**
 * Implementation of {@link ListDigitalTwinIncomingRelationships} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsRelationshipReadRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.ListDigitalTwinIncomingRelationships
 */
export const ListDigitalTwinIncomingRelationshipsHttp = Layer.effect(
  ListDigitalTwinIncomingRelationships,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.ListDigitalTwinIncomingRelationships",
    operation: dt.ListDigitalTwinIncomingRelationships,
    grant: DigitalTwinsRole.RelationshipRead,
  }),
);
