import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Layer from "effect/Layer";
import { DigitalTwinsRole, makeDigitalTwinsHttpBinding } from "./BindingHttp.ts";
import { QueryTwins } from "./QueryTwins.ts";

/**
 * Implementation of {@link QueryTwins} over the distilled `digitaltwins-data`
 * data plane. Assigns the custom `AzureDigitalTwinsQueryRole` on the
 * instance.
 *
 * @layer
 * @provides Azure.DigitalTwins.QueryTwins
 */
export const QueryTwinsHttp = Layer.effect(
  QueryTwins,
  makeDigitalTwinsHttpBinding({
    tag: "Azure.DigitalTwins.QueryTwins",
    operation: dt.QueryQueryTwins,
    grant: DigitalTwinsRole.Query,
  }),
);
