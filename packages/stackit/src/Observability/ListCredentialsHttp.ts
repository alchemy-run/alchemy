import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListCredentials } from "./ListCredentials.ts";

/**
 * HTTP implementation of {@link ListCredentials}.
 *
 * @layer
 * @provides Stackit.Observability.ListCredentials
 */
export const ListCredentialsHttp = Layer.effect(
  ListCredentials,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.ListCredentials",
    access: INSTANCE_READ_ACCESS,
    operation: observability.listCredentials,
  }),
);
