import * as sca from "@distilled.cloud/stackit/sca";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding } from "./BindingHttp.ts";
import { GetOverview } from "./GetOverview.ts";

/**
 * HTTP implementation of {@link GetOverview}.
 *
 * @layer
 * @provides Stackit.ContainerApplications.GetOverview
 */
export const GetOverviewHttp = Layer.effect(
  GetOverview,
  makeProjectHttpBinding({
    tag: "Stackit.ContainerApplications.GetOverview",
    permissions: ["sca.project.overview"],
    operation: sca.getOverview,
  }),
);
