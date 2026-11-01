import * as workflows from "@distilled.cloud/stackit/workflows";
import * as Layer from "effect/Layer";
import { makeInstanceHttpBinding } from "./BindingHttp.ts";
import { ListInstances } from "./ListInstances.ts";

/**
 * HTTP implementation of {@link ListInstances}.
 *
 * @layer
 * @provides Stackit.Workflows.ListInstances
 */
export const ListInstancesHttp = Layer.effect(
  ListInstances,
  makeInstanceHttpBinding({
    tag: "Stackit.Workflows.ListInstances",
    permission: "workflows.instance.list",
    operation: workflows.listInstances,
  }),
);
