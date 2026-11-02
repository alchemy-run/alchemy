import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListPostgreSQLChecks } from "./ListPostgreSQLChecks.ts";

/**
 * HTTP implementation of {@link ListPostgreSQLChecks}.
 *
 * @layer
 * @provides Stackit.Observability.ListPostgreSQLChecks
 */
export const ListPostgreSQLChecksHttp = Layer.effect(
  ListPostgreSQLChecks,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.ListPostgreSQLChecks",
    access: INSTANCE_READ_ACCESS,
    operation: observability.listPostgresqlChecks,
  }),
);
