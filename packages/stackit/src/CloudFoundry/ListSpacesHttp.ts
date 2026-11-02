import * as scf from "@distilled.cloud/stackit/scf";
import * as Layer from "effect/Layer";
import { makeOrganizationHttpBinding } from "./BindingHttp.ts";
import { ListSpaces } from "./ListSpaces.ts";

/**
 * HTTP implementation of {@link ListSpaces}.
 *
 * @layer
 * @provides Stackit.CloudFoundry.ListSpaces
 */
export const ListSpacesHttp = Layer.effect(
  ListSpaces,
  makeOrganizationHttpBinding({
    tag: "Stackit.CloudFoundry.ListSpaces",
    permissions: ["scf.space.list"],
    operation: scf.listSpaces,
  }),
);
