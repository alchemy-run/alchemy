import * as mariadb from "@distilled.cloud/stackit/mariadb";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetUpdates } from "./GetUpdates.ts";

/**
 * HTTP implementation of {@link GetUpdates}.
 *
 * @layer
 * @provides Stackit.MariaDB.GetUpdates
 */
export const GetUpdatesHttp = Layer.effect(
  GetUpdates,
  makeInstanceHttpBinding({
    tag: "Stackit.MariaDB.GetUpdates",
    permission: "mariadb.proxy.read",
    operation: mariadb.getUpdates,
  }),
);
