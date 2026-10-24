import * as Azure from "@alchemy.run/azure";
import * as hybridnetwork from "@distilled.cloud/azure/hybridnetwork";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  artifacts: Azure.HybridNetwork.ManifestArtifact[];
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const publisher = yield* Azure.HybridNetwork.Publisher("Publisher", {
      resourceGroup: group.resourceGroupName,
      location,
    });
    const store = yield* Azure.HybridNetwork.ArtifactStore("Store", {
      resourceGroup: group.resourceGroupName,
      publisher: publisher.publisherName,
      location,
    });
    const manifest = yield* Azure.HybridNetwork.ArtifactManifest("Manifest", {
      resourceGroup: group.resourceGroupName,
      publisher: publisher.publisherName,
      artifactStore: store.artifactStoreName,
      location,
      artifacts: props.artifacts,
      tags: props.tags,
    });
    return { group, publisher, store, manifest };
  });

const v1: Azure.HybridNetwork.ManifestArtifact = {
  artifactName: "tmpl",
  artifactType: "ArmTemplate",
  artifactVersion: "1.0.0",
};
const v2: Azure.HybridNetwork.ManifestArtifact = { ...v1, artifactVersion: "2.0.0" };

// Provisions a Standard container registry in an AOSM-managed resource
// group (the manifest itself is free): well under $0.05 per run, ~5 minutes.
test.provider(
  "create, update, replace, and delete an artifact manifest",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ artifacts: [v1], tags: { env: "one" } }));
      const { group, publisher, store, manifest } = created;
      const get = (name: string) =>
        Effect.gen(function* () {
          return yield* hybridnetwork.GetArtifactManifest({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            publisherName: publisher.publisherName,
            artifactStoreName: store.artifactStoreName,
            artifactManifestName: name,
          });
        });
      expect(manifest.artifacts).toEqual([v1]);
      expect(manifest.tags).toEqual({ env: "one" });
      const observed = yield* get(manifest.artifactManifestName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.artifacts?.[0]?.artifactVersion).toEqual("1.0.0");
      expect(observed.tags?.env).toEqual("one");
      expect(observed.tags?.["alchemy::id"]).toEqual("Manifest");

      // In-place: tags.
      const updated = yield* stack.deploy(program({ artifacts: [v1], tags: { env: "two" } }));
      expect(updated.manifest.artifactManifestId).toEqual(manifest.artifactManifestId);
      expect((yield* get(manifest.artifactManifestName)).tags?.env).toEqual("two");

      // Replacement: manifests are immutable, so a new artifact list replaces it.
      const replaced = yield* stack.deploy(program({ artifacts: [v2], tags: { env: "two" } }));
      expect(replaced.manifest.artifactManifestName).not.toEqual(manifest.artifactManifestName);
      const fresh = yield* get(replaced.manifest.artifactManifestName);
      expect(fresh.properties?.artifacts?.[0]?.artifactVersion).toEqual("2.0.0");
      expect(yield* waitGone(get(manifest.artifactManifestName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.manifest.artifactManifestName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
