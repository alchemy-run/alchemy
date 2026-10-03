import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hybridnetwork from "@distilled.cloud/azure/hybridnetwork";
import { expect } from "alchemy-test";
import { runExpensive } from "../gates.ts";
import * as Effect from "effect/Effect";
import {
  location,
  logLevel,
  subscription,
  tags,
  template,
  uploadTemplate,
  waitGone,
  withStore,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { region: string; tags: Record<string, string> }) =>
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
        version: "1.0.0",
        networkFunctionType: "VirtualNetworkFunction",
        deployParameters: JSON.stringify({
          type: "object",
          properties: { region: { type: "string" } },
        }),
        networkFunctionTemplate: {
          nfviType: "AzureCore",
          networkFunctionApplications: [
            {
              artifactType: "ArmTemplate",
              name: "app",
              artifactProfile: {
                artifactStore: { id: store.artifactStoreId },
                templateArtifactProfile: {
                  templateName: template.name,
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
        versionState: "Active",
      },
    );
    // The NFVI: an Azure Core resource group the function deploys into.
    const target = yield* Azure.Resources.ResourceGroup("Target", { location });
    const nf = yield* Azure.HybridNetwork.NetworkFunction("Function", {
      resourceGroup: group.resourceGroupName,
      location,
      networkFunctionDefinitionVersionId: nfdv.networkFunctionDefinitionVersionId,
      nfviType: "AzureCore",
      nfviId: target.resourceGroupId,
      deploymentValues: JSON.stringify({ region: props.region }),
      allowSoftwareUpdate: true,
      tags: props.tags,
    });
    return { group, publisher, store, manifest, nf };
  });

// A Standard ACR artifact store plus an AOSM deployment of an empty ARM
// template onto an Azure Core resource group: a few cents per run, but the
// deployment alone runs ~10 minutes and on the trial subscription it ends in
// provisioningState 'Failed' (likely needs the function's identity granted
// on the NFVI resource group and/or a VHD image for an Azure Core VNF).
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a network function",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Publish the template artifact before the definition references it.
      const published = yield* stack.deploy(withStore);
      yield* uploadTemplate({
        resourceGroupName: published.group.resourceGroupName,
        publisherName: published.publisher.publisherName,
        artifactStoreName: published.store.artifactStoreName,
        artifactManifestName: published.manifest.artifactManifestName,
      });

      const { group, nf } = yield* stack.deploy(
        program({ region: "one", tags: { env: "one" } }),
      );
      const get = Effect.gen(function* () {
        return yield* hybridnetwork.GetNetworkFunction({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          networkFunctionName: nf.networkFunctionName,
        });
      });
      const observed = yield* get;
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(JSON.parse(observed.properties?.deploymentValues ?? "{}")).toEqual(
        { region: "one" },
      );
      expect(observed.tags?.env).toEqual("one");

      // In-place: deployment values (redeploy) and tags.
      const updated = yield* stack.deploy(
        program({ region: "two", tags: { env: "two" } }),
      );
      expect(updated.nf.networkFunctionId).toEqual(nf.networkFunctionId);
      const reobserved = yield* get;
      expect(
        JSON.parse(reobserved.properties?.deploymentValues ?? "{}"),
      ).toEqual({ region: "two" });
      expect(reobserved.tags?.env).toEqual("two");

      yield* stack.destroy();
      expect(yield* waitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
