import * as authorization from "@distilled.cloud/stackit/authorization";
import * as Layer from "effect/Layer";
import { makeUnscopedHttpBinding } from "./BindingHttp.ts";
import { ListPermissions } from "./ListPermissions.ts";

/**
 * HTTP implementation of {@link ListPermissions}.
 *
 * @layer
 * @provides Stackit.IAM.ListPermissions
 */
export const ListPermissionsHttp = Layer.effect(
  ListPermissions,
  makeUnscopedHttpBinding({
    tag: "Stackit.IAM.ListPermissions",
    operation: authorization.listPermissions,
  }),
);
