import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { GetCatalog } from "./GetCatalog.ts";

/**
 * Implementation of {@link GetCatalog} over the distilled `devcenter-data`
 * data plane. Assigns the custom `AzureDevCenterCatalogReadRole` on the
 * project.
 *
 * @layer
 * @provides Azure.DevCenter.GetCatalog
 */
export const GetCatalogHttp = Layer.effect(
  GetCatalog,
  makeProjectHttpBinding({
    tag: "Azure.DevCenter.GetCatalog",
    operation: devcenter.GetEnvironmentCatalog,
    grants: [DevCenterRole.CatalogRead],
  }),
);
