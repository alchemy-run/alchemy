import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { ListCatalogs } from "./ListCatalogs.ts";

/**
 * Implementation of {@link ListCatalogs} over the distilled `devcenter-data`
 * data plane. Assigns the custom `AzureDevCenterCatalogReadRole` on the
 * project.
 *
 * @layer
 * @provides Azure.DevCenter.ListCatalogs
 */
export const ListCatalogsHttp = Layer.effect(
  ListCatalogs,
  makeProjectHttpBinding({
    tag: "Azure.DevCenter.ListCatalogs",
    operation: devcenter.ListEnvironmentCatalogsByProject,
    grants: [DevCenterRole.CatalogRead],
  }),
);
