import * as dremio from "@distilled.cloud/stackit/dremio";
import * as Layer from "effect/Layer";
import { makeUserHttpBinding } from "./BindingHttp.ts";
import { GetUser } from "./GetUser.ts";

/**
 * HTTP implementation of {@link GetUser}.
 *
 * @layer
 * @provides Stackit.Dremio.GetUser
 */
export const GetUserHttp = Layer.effect(
  GetUser,
  makeUserHttpBinding({
    tag: "Stackit.Dremio.GetUser",
    permission: "dremio.user.get",
    operation: dremio.getDremioUser,
  }),
);
