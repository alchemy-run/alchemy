import * as Azure from "@/Azure";
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
  version: string;
  versionState?: "Active";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, publisher, store } = yield* withStore;
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
        version: props.version,
        description: `design ${props.version}`,
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
        versionState: props.versionState,
        tags: props.tags,
      },
    );
    return { group, publisher, nsdg, nsdv };
  });

// Metadata resources plus a Standard ACR artifact store: a few cents, ~5 minutes.
test.provider(
  "create, update, replace, and delete a network service design version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // AOSM validates the design against the uploaded template artifact.
      const published = yield* stack.deploy(withStore);
      yield* uploadTemplate({
        resourceGroupName: published.group.resourceGroupName,
        publisherName: published.publisher.publisherName,
        artifactStoreName: published.store.artifactStoreName,
        artifactManifestName: published.manifest.artifactManifestName,
      });

      const { group, publisher, nsdg, nsdv } = yield* stack.deploy(
        program({ version: "1.0.0", tags: { env: "one" } }),
      );
      const get = (version: string) =>
        Effect.gen(function* () {
          return yield* hybridnetwork.GetNetworkServiceDesignVersion({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            publisherName: publisher.publisherName,
            networkServiceDesignGroupName: nsdg.networkServiceDesignGroupName,
            networkServiceDesignVersionName: version,
          });
        });
      expect(nsdv.networkServiceDesignVersionName).toEqual("1.0.0");
      const observed = yield* get("1.0.0");
      expect(
        Object.keys(observed.properties?.configurationGroupSchemaReferences ?? {}),
      ).toEqual(["config"]);
      expect(observed.properties?.nfvisFromSite?.core?.type).toEqual(
        "AzureCore",
      );
      expect(observed.tags?.env).toEqual("one");

      // In-place: tags and publish the version.
      const updated = yield* stack.deploy(
        program({
          version: "1.0.0",
          versionState: "Active",
          tags: { env: "two" },
        }),
      );
      expect(updated.nsdv.networkServiceDesignVersionId).toEqual(
        nsdv.networkServiceDesignVersionId,
      );
      const reobserved = yield* get("1.0.0");
      expect(reobserved.tags?.env).toEqual("two");
      expect(reobserved.properties?.versionState).toEqual("Active");

      // Replacement: versions are immutable, a new version replaces the old.
      const replaced = yield* stack.deploy(
        program({ version: "2.0.0", tags: { env: "two" } }),
      );
      expect(replaced.nsdv.networkServiceDesignVersionName).toEqual("2.0.0");
      expect((yield* get("2.0.0")).properties?.description).toEqual(
        "design 2.0.0",
      );
      expect(yield* waitGone(get("1.0.0"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("2.0.0"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
