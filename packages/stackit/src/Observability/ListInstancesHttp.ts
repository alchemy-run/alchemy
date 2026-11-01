import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_LIST_ACCESS, makeProjectHttpBinding } from "./BindingHttp.ts";
import { ListInstances } from "./ListInstances.ts";

/**
 * HTTP implementation of {@link ListInstances}.
 *
 * @layer
 * @provides Stackit.Observability.ListInstances
 */
export const ListInstancesHttp = Layer.effect(
  ListInstances,
  makeProjectHttpBinding({
    tag: "Stackit.Observability.ListInstances",
    access: INSTANCE_LIST_ACCESS,
    operation: observability.listInstances,
  }),
);
