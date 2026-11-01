import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListMongoDBChecks } from "./ListMongoDBChecks.ts";

/**
 * HTTP implementation of {@link ListMongoDBChecks}.
 *
 * @layer
 * @provides Stackit.Observability.ListMongoDBChecks
 */
export const ListMongoDBChecksHttp = Layer.effect(
  ListMongoDBChecks,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.ListMongoDBChecks",
    access: INSTANCE_READ_ACCESS,
    operation: observability.listMongodbChecks,
  }),
);
