import * as logme from "@distilled.cloud/stackit/logme";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListCredentials } from "./ListCredentials.ts";

/**
 * HTTP implementation of {@link ListCredentials}.
 *
 * @layer
 * @provides Stackit.LogMe.ListCredentials
 */
export const ListCredentialsHttp = Layer.effect(
  ListCredentials,
  makeInstanceHttpBinding({
    tag: "Stackit.LogMe.ListCredentials",
    permission: "logme.credential.list",
    operation: logme.listCredentials,
  }),
);
