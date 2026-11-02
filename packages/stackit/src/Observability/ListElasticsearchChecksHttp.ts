import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListElasticsearchChecks } from "./ListElasticsearchChecks.ts";

/**
 * HTTP implementation of {@link ListElasticsearchChecks}.
 *
 * @layer
 * @provides Stackit.Observability.ListElasticsearchChecks
 */
export const ListElasticsearchChecksHttp = Layer.effect(
  ListElasticsearchChecks,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.ListElasticsearchChecks",
    access: INSTANCE_READ_ACCESS,
    operation: observability.listElasticsearchChecks,
  }),
);
