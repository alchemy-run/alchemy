import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as hybridnetwork from "@distilled.cloud/azure/hybridnetwork";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  location,
  logLevel,
  subscription,
  tags,
  template,
  waitGone,
  withStore,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const deployParameters = JSON.stringify({
  type: "object",
  properties: { vmSize: { type: "string" } },
});

const program = (props: {
  version: string;
  description: string;
  versionState?: "Active";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, publisher, store, manifest } = yield* withStore;
    const nfdg = yield* Azure.HybridNetwork.NetworkFunctionDefinitionGroup(
      "Nfdg",
      {
        resourceGroup: group.resourceGroupName,
        publisher: publisher.publisherName,
        location,
      },
    );
    const nfdv = yield* Azure.HybridNetwork.NetworkFunctionDefinitionVersion(
      "Nfdv",
      {
        resourceGroup: group.resourceGroupName,
        publisher: publisher.publisherName,
        networkFunctionDefinitionGroup: nfdg.networkFunctionDefinitionGroupName,
        location,
        version: props.version,
        networkFunctionType: "VirtualNetworkFunction",
        description: props.description,
        deployParameters,
        networkFunctionTemplate: {
          nfviType: "AzureCore",
          networkFunctionApplications: [
            {
              artifactType: "ArmTemplate",
              name: "app",
              // Orders the version after the manifest declaring the artifact.
              artifactProfile: {
                artifactStore: { id: store.artifactStoreId },
                templateArtifactProfile: {
                  templateName: Output.map(
                    manifest.artifactManifestName,
                    () => template.name,
                  ),
                  templateVersion: template.version,
                },
              },
              deployParametersMappingRuleProfile: {
                applicationEnablement: "Unknown",
                templateMappingRuleProfile: { templateParameters: "{}" },
              },
            },
          ],
        },
        versionState: props.versionState,
        tags: props.tags,
      },
    );
    return { group, publisher, nfdg, nfdv };
  });

// Metadata resources plus a Standard ACR artifact store: a few cents, ~5 minutes.
test.provider(
  "create, update, replace, and delete a network function definition version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, publisher, nfdg, nfdv } = yield* stack.deploy(
        program({ version: "1.0.0", description: "v1", tags: { env: "one" } }),
      );
      const get = (version: string) =>
        Effect.gen(function* () {
          return yield* hybridnetwork.GetNetworkFunctionDefinitionVersion({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            publisherName: publisher.publisherName,
            networkFunctionDefinitionGroupName:
              nfdg.networkFunctionDefinitionGroupName,
            networkFunctionDefinitionVersionName: version,
          });
        });
      expect(nfdv.networkFunctionDefinitionVersionName).toEqual("1.0.0");
      const observed = yield* get("1.0.0");
      expect(observed.properties?.networkFunctionType).toEqual(
        "VirtualNetworkFunction",
      );
      expect(observed.properties?.description).toEqual("v1");
      expect(observed.tags?.env).toEqual("one");

      // In-place: tags and publish the version.
      const updated = yield* stack.deploy(
        program({
          version: "1.0.0",
          description: "v1",
          versionState: "Active",
          tags: { env: "two" },
        }),
      );
      expect(updated.nfdv.networkFunctionDefinitionVersionId).toEqual(
        nfdv.networkFunctionDefinitionVersionId,
      );
      const reobserved = yield* get("1.0.0");
      expect(reobserved.tags?.env).toEqual("two");
      expect(reobserved.properties?.versionState).toEqual("Active");

      // Replacement: versions are immutable, a new version replaces the old.
      const replaced = yield* stack.deploy(
        program({ version: "2.0.0", description: "v2", tags: { env: "two" } }),
      );
      expect(replaced.nfdv.networkFunctionDefinitionVersionName).toEqual(
        "2.0.0",
      );
      expect((yield* get("2.0.0")).properties?.description).toEqual("v2");
      expect(yield* waitGone(get("1.0.0"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("2.0.0"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
