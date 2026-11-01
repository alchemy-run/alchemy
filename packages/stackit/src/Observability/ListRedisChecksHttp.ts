import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListRedisChecks } from "./ListRedisChecks.ts";

/**
 * HTTP implementation of {@link ListRedisChecks}.
 *
 * @layer
 * @provides Stackit.Observability.ListRedisChecks
 */
export const ListRedisChecksHttp = Layer.effect(
  ListRedisChecks,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.ListRedisChecks",
    access: INSTANCE_READ_ACCESS,
    operation: observability.listRedisChecks,
  }),
);
