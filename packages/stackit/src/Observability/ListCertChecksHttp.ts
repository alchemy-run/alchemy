import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListCertChecks } from "./ListCertChecks.ts";

/**
 * HTTP implementation of {@link ListCertChecks}.
 *
 * @layer
 * @provides Stackit.Observability.ListCertChecks
 */
export const ListCertChecksHttp = Layer.effect(
  ListCertChecks,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.ListCertChecks",
    access: INSTANCE_READ_ACCESS,
    operation: observability.listCertChecks,
  }),
);
