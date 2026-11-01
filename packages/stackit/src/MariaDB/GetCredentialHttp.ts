import * as mariadb from "@distilled.cloud/stackit/mariadb";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { GetCredential } from "./GetCredential.ts";

/**
 * HTTP implementation of {@link GetCredential}.
 *
 * @layer
 * @provides Stackit.MariaDB.GetCredential
 */
export const GetCredentialHttp = Layer.effect(
  GetCredential,
  makeInstanceHttpBinding({
    tag: "Stackit.MariaDB.GetCredential",
    permission: "mariadb.credential.get",
    operation: mariadb.getCredentials,
  }),
);
