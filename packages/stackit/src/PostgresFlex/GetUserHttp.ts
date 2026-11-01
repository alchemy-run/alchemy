import * as postgres from "@distilled.cloud/stackit/postgres_flex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetUser } from "./GetUser.ts";

/**
 * HTTP implementation of {@link GetUser}.
 *
 * @layer
 * @provides Stackit.PostgresFlex.GetUser
 */
export const GetUserHttp = Layer.effect(
  GetUser,
  makeInstanceHttpBinding({
    tag: "Stackit.PostgresFlex.GetUser",
    access: { permissions: ["postgres-flex.user.get"] },
    operation: postgres.getUser,
  }),
);
