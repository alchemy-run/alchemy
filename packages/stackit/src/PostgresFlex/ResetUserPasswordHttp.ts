import * as postgres from "@distilled.cloud/stackit/postgres_flex";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ResetUserPassword } from "./ResetUserPassword.ts";

/**
 * HTTP implementation of {@link ResetUserPassword}.
 *
 * @layer
 * @provides Stackit.PostgresFlex.ResetUserPassword
 */
export const ResetUserPasswordHttp = Layer.effect(
  ResetUserPassword,
  makeInstanceHttpBinding({
    tag: "Stackit.PostgresFlex.ResetUserPassword",
    access: { permissions: ["postgres-flex.user.reset"] },
    operation: postgres.resetUserPassword,
  }),
);
