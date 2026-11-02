import * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ResetUser } from "./ResetUser.ts";

/**
 * HTTP implementation of {@link ResetUser}.
 *
 * @layer
 * @provides Stackit.SQLServerFlex.ResetUser
 */
export const ResetUserHttp = Layer.effect(
  ResetUser,
  makeInstanceHttpBinding({
    tag: "Stackit.SQLServerFlex.ResetUser",
    access: { permissions: ["sqlserver-flex.user.reset"] },
    operation: sqlserver.resetUser,
  }),
);
