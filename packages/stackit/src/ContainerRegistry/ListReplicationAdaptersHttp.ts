import * as registry from "@distilled.cloud/stackit/registry";
import * as Layer from "effect/Layer";
import { makeLocationHttpBinding } from "./BindingHttp.ts";
import { ListReplicationAdapters } from "./ListReplicationAdapters.ts";

/**
 * HTTP implementation of {@link ListReplicationAdapters}.
 *
 * @layer
 * @provides Stackit.ContainerRegistry.ListReplicationAdapters
 */
export const ListReplicationAdaptersHttp = Layer.effect(
  ListReplicationAdapters,
  makeLocationHttpBinding({
    tag: "Stackit.ContainerRegistry.ListReplicationAdapters",
    permissions: ["container-registry.project.create"],
    operation: registry.listReplicationAdapters,
  }),
);
