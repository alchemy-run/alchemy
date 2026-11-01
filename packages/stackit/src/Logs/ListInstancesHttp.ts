import * as logs from "@distilled.cloud/stackit/logs";
import * as Layer from "effect/Layer";
import { makeProjectHttpBinding } from "./BindingHttp.ts";
import { ListInstances } from "./ListInstances.ts";

/**
 * HTTP implementation of {@link ListInstances}.
 *
 * @layer
 * @provides Stackit.Logs.ListInstances
 */
export const ListInstancesHttp = Layer.effect(
  ListInstances,
  makeProjectHttpBinding({
    tag: "Stackit.Logs.ListInstances",
    permission: "logs.instance.list",
    operation: logs.listLogsInstances,
  }),
);
