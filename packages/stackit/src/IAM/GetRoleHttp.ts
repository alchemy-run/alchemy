import * as authorization from "@distilled.cloud/stackit/authorization";
import * as Layer from "effect/Layer";
import { makeCustomRoleHttpBinding } from "./BindingHttp.ts";
import { GetRole } from "./GetRole.ts";

/**
 * HTTP implementation of {@link GetRole}.
 *
 * @layer
 * @provides Stackit.IAM.GetRole
 */
export const GetRoleHttp = Layer.effect(
  GetRole,
  makeCustomRoleHttpBinding({
    tag: "Stackit.IAM.GetRole",
    access: { permissions: ["iam.role.get"] },
    operation: authorization.getRole,
  }),
);
