import * as codeconnections from "@distilled.cloud/aws/codeconnections";
import * as Layer from "effect/Layer";
import { makeRepositoryLinkScopedHttpBinding } from "./BindingHttp.ts";
import { ListRepositorySyncDefinitions } from "./ListRepositorySyncDefinitions.ts";

export const ListRepositorySyncDefinitionsHttp = Layer.effect(
  ListRepositorySyncDefinitions,
  makeRepositoryLinkScopedHttpBinding<
    codeconnections.ListRepositorySyncDefinitionsInput,
    codeconnections.ListRepositorySyncDefinitionsOutput,
    codeconnections.ListRepositorySyncDefinitionsError
  >({
    tag: "AWS.CodeConnections.ListRepositorySyncDefinitions",
    actions: ["codeconnections:ListRepositorySyncDefinitions"],
    operation: codeconnections.listRepositorySyncDefinitions,
  }),
);
