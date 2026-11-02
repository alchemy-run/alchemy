import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListMySQLChecks } from "./ListMySQLChecks.ts";

/**
 * HTTP implementation of {@link ListMySQLChecks}.
 *
 * @layer
 * @provides Stackit.Observability.ListMySQLChecks
 */
export const ListMySQLChecksHttp = Layer.effect(
  ListMySQLChecks,
  makeInstanceHttpBinding({
    tag: "Stackit.Observability.ListMySQLChecks",
    access: INSTANCE_READ_ACCESS,
    operation: observability.listMysqlChecks,
  }),
);
