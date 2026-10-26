import * as devcenter from "@distilled.cloud/azure/devcenter-data";
import * as Layer from "effect/Layer";
import { makeProjectUserHttpBinding, DevCenterRole } from "./BindingHttp.ts";
import { ListDevBoxActions } from "./ListDevBoxActions.ts";

/**
 * Implementation of {@link ListDevBoxActions} over the distilled
 * `devcenter-data` data plane. Assigns the custom
 * `AzureDevCenterDevBoxActionReadRole` on the project.
 *
 * @layer
 * @provides Azure.DevCenter.ListDevBoxActions
 */
export const ListDevBoxActionsHttp = Layer.effect(
  ListDevBoxActions,
  makeProjectUserHttpBinding({
    tag: "Azure.DevCenter.ListDevBoxActions",
    operation: devcenter.ListDevBoxActions,
    grants: [DevCenterRole.DevBoxActionRead],
  }),
);
