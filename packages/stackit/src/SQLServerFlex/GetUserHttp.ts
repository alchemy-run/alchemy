import * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetUser } from "./GetUser.ts";

/**
 * HTTP implementation of {@link GetUser}.
 *
 * @layer
 * @provides Stackit.SQLServerFlex.GetUser
 */
export const GetUserHttp = Layer.effect(
  GetUser,
  makeInstanceHttpBinding({
    tag: "Stackit.SQLServerFlex.GetUser",
    access: { permissions: ["sqlserver-flex.user.get"] },
    operation: sqlserver.getUser,
  }),
);
