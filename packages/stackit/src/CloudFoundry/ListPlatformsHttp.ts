import * as scf from "@distilled.cloud/stackit/scf";
import * as Layer from "effect/Layer";
import { makeOrganizationProjectHttpBinding } from "./BindingHttp.ts";
import { ListPlatforms } from "./ListPlatforms.ts";

/**
 * HTTP implementation of {@link ListPlatforms}.
 *
 * @layer
 * @provides Stackit.CloudFoundry.ListPlatforms
 */
export const ListPlatformsHttp = Layer.effect(
  ListPlatforms,
  makeOrganizationProjectHttpBinding({
    tag: "Stackit.CloudFoundry.ListPlatforms",
    permissions: ["scf.platform.list"],
    operation: scf.listPlatforms,
  }),
);
