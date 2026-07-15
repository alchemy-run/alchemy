import * as codeconnections from "@distilled.cloud/aws/codeconnections";
import * as Layer from "effect/Layer";
import { makeRepositoryLinkScopedHttpBinding } from "./BindingHttp.ts";
import { ListSyncConfigurations } from "./ListSyncConfigurations.ts";

export const ListSyncConfigurationsHttp = Layer.effect(
  ListSyncConfigurations,
  makeRepositoryLinkScopedHttpBinding<
    codeconnections.ListSyncConfigurationsInput,
    codeconnections.ListSyncConfigurationsOutput,
    codeconnections.ListSyncConfigurationsError
  >({
    tag: "AWS.CodeConnections.ListSyncConfigurations",
    actions: ["codeconnections:ListSyncConfigurations"],
    operation: codeconnections.listSyncConfigurations,
  }),
);
