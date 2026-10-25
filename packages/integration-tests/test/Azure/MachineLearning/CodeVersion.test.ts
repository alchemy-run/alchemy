import * as Azure from "@alchemy.run/azure";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import type { InputProps } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { baseDefault, location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getVersion = (
  resourceGroupName: string,
  workspaceName: string,
  name: string,
  version: string,
) =>
  Effect.gen(function* () {
    return yield* ml.GetCodeVersion({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
      name,
      version,
    });
  });

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
    const version = yield* Azure.MachineLearning.CodeVersion("TrainerV1", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      name: "trainer",
      version: props.version,
      description: props.description,
      tags: props.tags,
      ...(props.variant === "a"
        ? ({
            codeUri: Output.interpolate`https://${base.storage.storageAccountName}.blob.core.windows.net/azureml-blobstore-${base.workspace.mlWorkspaceId}/code/trainer-a`,
          } satisfies Partial<InputProps<Azure.MachineLearning.CodeVersionProps>>)
        : ({
            codeUri: Output.interpolate`https://${base.storage.storageAccountName}.blob.core.windows.net/azureml-blobstore-${base.workspace.mlWorkspaceId}/code/trainer-b`,
          } satisfies Partial<InputProps<Azure.MachineLearning.CodeVersionProps>>)),
    });
    return { ...base, version };
  });

// Code assets are free; the Default workspace has no hourly charge. ~4-6 minutes.
// Skipped: BadRequest: Uri does not contain any blobs — the code snapshot must be uploaded to the workspace blob store before the version is registered.
test.provider.skip(
  "create, update, replace, and delete a code version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, version } = yield* stack.deploy(
        program({ variant: "a", version: "1", description: "v1", tags: { env: "test" } }),
      );
      const get = (v: string) =>
        getVersion(group.resourceGroupName, workspace.workspaceName, "trainer", v);
      expect(version?.version).toEqual("1");
      expect(version?.tags).toEqual({ env: "test" });
      let observed = yield* get("1");
      expect(observed.properties.description).toEqual("v1");
      expect(observed.properties.tags?.env).toEqual("test");
      expect(observed.properties.tags?.["alchemy::id"]).toEqual("TrainerV1");
      expect(observed.properties.codeUri).toMatch(/\/code\/trainer-a$/);

      // In place: description and tags.
      const updated = yield* stack.deploy(
        program({ variant: "a", version: "1", description: "v1 updated", tags: { env: "prod" } }),
      );
      expect(updated.version?.versionId).toEqual(version?.versionId);
      observed = yield* get("1");
      expect(observed.properties.description).toEqual("v1 updated");
      expect(observed.properties.tags?.env).toEqual("prod");

      // Replacement at the same name and version: new content.
      yield* stack.deploy(
        program({ variant: "b", version: "1", description: "v1 updated", tags: { env: "prod" } }),
      );
      observed = yield* get("1");
      expect(observed.properties.codeUri).toMatch(/\/code\/trainer-b$/);

      // Removing the version deletes it.
      yield* stack.deploy(
        program({
          variant: "b",
          version: "1",
          description: "v1 updated",
          tags: {},
          withVersion: false,
        }),
      );
      expect(yield* waitGone(get("1"))).toEqual("gone");

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
  const container = yield* Azure.MachineLearning.CodeContainer("Trainer", {
    resourceGroup: group.resourceGroupName,
    registry: registry.registryName,
    description: "shared",
  });
  const version = yield* Azure.MachineLearning.CodeVersion("TrainerV1", {
    resourceGroup: group.resourceGroupName,
    registry: registry.registryName,
    name: container.containerName,
    version: "1",
    description: "shared v1",
    codeUri: Output.interpolate`https://${registry.registryName}.blob.core.windows.net/code/trainer-a`,
  });
  return { group, registry, container, version };
});

// ~$0.10/run, 20 min: a registry provisions a managed Premium container
// registry and storage account and takes ~5-7 minutes to create and delete.
test.provider.skipIf(!runExpensive)(
  "create and delete a code container and version in a registry",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, registry, container, version } = yield* stack.deploy(registryProgram);
      const subscriptionId = yield* subscription;
      expect(container.registry).toEqual(registry.registryName);
      expect(version.registry).toEqual(registry.registryName);
      const observedContainer = yield* ml.GetRegistryCodeContainer({
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
        registryName: registry.registryName,
        codeName: container.containerName,
      });
      expect(observedContainer.properties.description).toEqual("shared");
      const getVersion = ml.GetRegistryCodeVersion({
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
        registryName: registry.registryName,
        codeName: container.containerName,
        version: "1",
      });
      const observedVersion = yield* getVersion;
      expect(observedVersion.properties.description).toEqual("shared v1");
      expect(observedVersion.properties.tags?.["alchemy::id"]).toEqual("TrainerV1");

      yield* stack.destroy();
      expect(yield* waitGone(getVersion)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);
