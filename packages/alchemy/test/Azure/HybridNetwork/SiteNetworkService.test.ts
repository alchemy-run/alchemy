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

const schemaDefinition = JSON.stringify({
  type: "object",
  properties: { region: { type: "string" } },
});

const program = (props: {
  values: "One" | "Two";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, publisher, store, manifest } = yield* withStore;
    const schema = yield* Azure.HybridNetwork.ConfigurationGroupSchema(
      "Schema",
      {
        resourceGroup: group.resourceGroupName,
        publisher: publisher.publisherName,
        location,
        schemaDefinition,
        versionState: "Active",
      },
    );
    const nsdg = yield* Azure.HybridNetwork.NetworkServiceDesignGroup("Nsdg", {
      resourceGroup: group.resourceGroupName,
      publisher: publisher.publisherName,
      location,
    });
    const nsdv = yield* Azure.HybridNetwork.NetworkServiceDesignVersion(
      "Nsdv",
      {
        resourceGroup: group.resourceGroupName,
        publisher: publisher.publisherName,
        networkServiceDesignGroup: nsdg.networkServiceDesignGroupName,
        location,
        version: "1.0.0",
        configurationGroupSchemaReferences: {
          config: schema.configurationGroupSchemaId,
        },
        nfvisFromSite: { core: { name: "core", type: "AzureCore" } },
        resourceElementTemplates: [
          {
            name: "network",
            type: "ArmResourceDefinition",
            configuration: {
              templateType: "ArmTemplate",
              parameterValues: "{}",
              artifactProfile: {
                artifactStoreReference: { id: store.artifactStoreId },
                artifactName: template.name,
                artifactVersion: template.version,
              },
            },
          },
        ],
        versionState: "Active",
      },
    );
    const site = yield* Azure.HybridNetwork.Site("Site", {
      resourceGroup: group.resourceGroupName,
      location,
      nfvis: [{ name: "core", nfviType: "AzureCore", location }],
    });
    const valuesOne = yield* Azure.HybridNetwork.ConfigurationGroupValue(
      "ValuesOne",
      {
        resourceGroup: group.resourceGroupName,
        location,
        configurationGroupSchemaId: schema.configurationGroupSchemaId,
        configurationValue: JSON.stringify({ region: "one" }),
      },
    );
    const valuesTwo = yield* Azure.HybridNetwork.ConfigurationGroupValue(
      "ValuesTwo",
      {
        resourceGroup: group.resourceGroupName,
        location,
        configurationGroupSchemaId: schema.configurationGroupSchemaId,
        configurationValue: JSON.stringify({ region: "two" }),
      },
    );
    const sns = yield* Azure.HybridNetwork.SiteNetworkService("Service", {
      resourceGroup: group.resourceGroupName,
      location,
      siteId: site.siteId,
      networkServiceDesignVersionId: nsdv.networkServiceDesignVersionId,
      configurationGroupValues: {
        config: (props.values === "One" ? valuesOne : valuesTwo)
          .configurationGroupValueId,
      },
      tags: props.tags,
    });
    return {
      group,
      publisher,
      store,
      manifest,
      valuesOne,
      valuesTwo,
      sns,
    };
  });

// A Standard ACR artifact store plus an AOSM deployment of an empty ARM
// template: a few cents per run, ~10 minutes.
test.provider(
  "create, update tags, and delete a site network service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Publish the template artifact before the design references it.
      const published = yield* stack.deploy(withStore);
      yield* uploadTemplate({
        resourceGroupName: published.group.resourceGroupName,
        publisherName: published.publisher.publisherName,
        artifactStoreName: published.store.artifactStoreName,
        artifactManifestName: published.manifest.artifactManifestName,
      });

      const { group, sns, valuesOne } = yield* stack.deploy(
        program({ values: "One", tags: { env: "one" } }),
      );
      const get = Effect.gen(function* () {
        return yield* hybridnetwork.GetSiteNetworkService({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          siteNetworkServiceName: sns.siteNetworkServiceName,
        });
      });
      const observed = yield* get;
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.identity?.type).toEqual("SystemAssigned");
      expect(
        observed.properties?.desiredStateConfigurationGroupValueReferences?.config?.id?.toLowerCase(),
      ).toEqual(valuesOne.configurationGroupValueId.toLowerCase());
      expect(observed.tags?.env).toEqual("one");

      // In-place: tags.
      const updated = yield* stack.deploy(
        program({ values: "One", tags: { env: "two" } }),
      );
      expect(updated.sns.siteNetworkServiceId).toEqual(sns.siteNetworkServiceId);
      expect((yield* get).tags?.env).toEqual("two");

      yield* stack.destroy();
      expect(yield* waitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Redeploying with new configuration values runs a second AOSM deployment
// (~4-5 minutes each); with create and delete the lifecycle takes ~20
// minutes, past the test budget. A few cents per run.
test.provider.skipIf(!runExpensive)(
  "redeploy a site network service with new configuration values",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const published = yield* stack.deploy(withStore);
      yield* uploadTemplate({
        resourceGroupName: published.group.resourceGroupName,
        publisherName: published.publisher.publisherName,
        artifactStoreName: published.store.artifactStoreName,
        artifactManifestName: published.manifest.artifactManifestName,
      });

      const { group, sns } = yield* stack.deploy(
        program({ values: "One", tags: { env: "one" } }),
      );
      const get = Effect.gen(function* () {
        return yield* hybridnetwork.GetSiteNetworkService({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          siteNetworkServiceName: sns.siteNetworkServiceName,
        });
      });

      // In-place: new configuration values redeploy the service.
      const updated = yield* stack.deploy(
        program({ values: "Two", tags: { env: "one" } }),
      );
      expect(updated.sns.siteNetworkServiceId).toEqual(sns.siteNetworkServiceId);
      const reobserved = yield* get;
      expect(reobserved.properties?.provisioningState).toEqual("Succeeded");
      expect(
        reobserved.properties?.desiredStateConfigurationGroupValueReferences?.config?.id?.toLowerCase(),
      ).toEqual(updated.valuesTwo.configurationGroupValueId.toLowerCase());

      yield* stack.destroy();
      expect(yield* waitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
