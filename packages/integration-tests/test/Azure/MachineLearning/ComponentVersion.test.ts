import * as Azure from "@alchemy.run/azure";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import type { InputProps } from "alchemy/Input";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { baseDefault, location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const componentSpec = (command: string) => ({
  $schema: "https://azuremlschemas.azureedge.net/latest/commandComponent.schema.json",
  name: "prep",
  version: "1",
  type: "command",
  command,
  environment: "azureml://registries/azureml/environments/sklearn-1.5/labels/latest",
});

const getVersion = (
  resourceGroupName: string,
  workspaceName: string,
  name: string,
  version: string,
) =>
  Effect.gen(function* () {
    return yield* ml.GetComponentVersion({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
      name,
      version,
    });
  });

/** Azure keeps a component version's description in its spec. */
const specOf = (observed: ml.GetComponentVersionResponse) =>
  observed.properties.componentSpec as { command?: string; description?: string };

const program = (props: {
  variant: "a" | "b";
  version: "1" | "2";
  description: string;
  tags: Record<string, string>;
  withVersion?: boolean;
}) =>
  Effect.gen(function* () {
    const base = yield* baseDefault();
    if (props.withVersion === false) return { ...base, version: undefined };
    const version = yield* Azure.MachineLearning.ComponentVersion("PrepV1", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      name: "prep",
      version: props.version,
      description: props.description,
      tags: props.tags,
      ...(props.variant === "a"
        ? ({ componentSpec: componentSpec("echo a") } satisfies Partial<
            InputProps<Azure.MachineLearning.ComponentVersionProps>
          >)
        : ({ componentSpec: componentSpec("echo b") } satisfies Partial<
            InputProps<Azure.MachineLearning.ComponentVersionProps>
          >)),
    });
    return { ...base, version };
  });

// Component assets are free; the Default workspace has no hourly charge. ~4-6 minutes.
test.provider(
  "create, update, replace, and delete a component version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, version } = yield* stack.deploy(
        program({ variant: "a", version: "1", description: "v1", tags: { env: "test" } }),
      );
      const get = (v: string) =>
        getVersion(group.resourceGroupName, workspace.workspaceName, "prep", v);
      expect(version?.version).toEqual("1");
      expect(version?.tags).toEqual({ env: "test" });
      let observed = yield* get("1");
      expect(specOf(observed).description).toEqual("v1");
      expect(observed.properties.tags?.env).toEqual("test");
      expect(observed.properties.tags?.["alchemy::id"]).toEqual("PrepV1");
      expect(specOf(observed).command).toEqual("echo a");

      // In place: description and tags.
      const updated = yield* stack.deploy(
        program({ variant: "a", version: "1", description: "v1 updated", tags: { env: "prod" } }),
      );
      expect(updated.version?.versionId).toEqual(version?.versionId);
      observed = yield* get("1");
      expect(specOf(observed).description).toEqual("v1 updated");
      expect(observed.properties.tags?.env).toEqual("prod");

      // Azure only archives workspace component versions: new content takes a
      // new version, and the old one is archived.
      yield* stack.deploy(
        program({ variant: "b", version: "2", description: "v1 updated", tags: { env: "prod" } }),
      );
      observed = yield* get("2");
      expect(specOf(observed).command).toEqual("echo b");
      expect((yield* get("1")).properties.isArchived).toEqual(true);

      // Removing the version archives it.
      yield* stack.deploy(
        program({
          variant: "b",
          version: "2",
          description: "v1 updated",
          tags: {},
          withVersion: false,
        }),
      );
      expect((yield* get("2")).properties.isArchived).toEqual(true);

      yield* stack.destroy();
      expect(yield* waitGone(get("1"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

const registryProgram = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", { location });
  const registry = yield* Azure.MachineLearning.Registry("Shared", {
    resourceGroup: group.resourceGroupName,
    location,
  });
  const container = yield* Azure.MachineLearning.ComponentContainer("Prep", {
    resourceGroup: group.resourceGroupName,
    registry: registry.registryName,
    description: "shared",
  });
  const version = yield* Azure.MachineLearning.ComponentVersion("PrepV1", {
    resourceGroup: group.resourceGroupName,
    registry: registry.registryName,
    name: container.containerName,
    version: "1",
    description: "shared v1",
    componentSpec: componentSpec("echo a"),
  });
  return { group, registry, container, version };
});

// ~$0.10/run, 20 min: a registry provisions a managed Premium container
// registry and storage account and takes ~5-7 minutes to create and delete.
test.provider.skipIf(!runExpensive)(
  "create and delete a component container and version in a registry",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, registry, container, version } = yield* stack.deploy(registryProgram);
      const subscriptionId = yield* subscription;
      expect(container.registry).toEqual(registry.registryName);
      expect(version.registry).toEqual(registry.registryName);
      const observedContainer = yield* ml.GetRegistryComponentContainer({
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
        registryName: registry.registryName,
        componentName: container.containerName,
      });
      expect(observedContainer.properties.description).toEqual("shared");
      const getVersion = ml.GetRegistryComponentVersion({
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
        registryName: registry.registryName,
        componentName: container.containerName,
        version: "1",
      });
      const observedVersion = yield* getVersion;
      expect(observedVersion.properties.description).toEqual("shared v1");
      expect(observedVersion.properties.tags?.["alchemy::id"]).toEqual("PrepV1");

      yield* stack.destroy();
      expect(yield* waitGone(getVersion)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);
