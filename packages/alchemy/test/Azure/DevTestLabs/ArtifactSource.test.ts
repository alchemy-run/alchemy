import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { labFixture, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSource = (resourceGroupName: string, labName: string, name: string) =>
  Effect.gen(function* () {
    return yield* devtestlabs.GetArtifactSource({
      subscriptionId: yield* subscription,
      resourceGroupName,
      labName,
      name,
    });
  });

/**
 * DevTest Labs requires a personal access token even for public GitHub
 * repositories (`MissingRequiredProperty: securityToken`), so the full
 * lifecycle only runs with `GITHUB_TOKEN` (read-only public scope is enough).
 */
const githubToken = process.env.GITHUB_TOKEN;

const program = (props: {
  status: "Enabled" | "Disabled";
  displayName: string;
}) =>
  Effect.gen(function* () {
    const { group, lab } = yield* labFixture();
    const source = yield* Azure.DevTestLabs.ArtifactSource("Artifacts", {
      resourceGroup: group.resourceGroupName,
      lab: lab.labName,
      displayName: props.displayName,
      uri: "https://github.com/Azure/azure-devtestlab.git",
      sourceType: "GitHub",
      folderPath: "/Artifacts",
      branchRef: "master",
      status: props.status,
      securityToken: Redacted.make(githubToken ?? ""),
    });
    return { group, lab, source };
  });

// Free lab + artifact source (public repo); ~5 minutes for the lab.
test.provider.skipIf(!githubToken)(
  "create, update, and delete an artifact source",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, lab, source } = yield* stack.deploy(
        program({ status: "Enabled", displayName: "Public artifacts" }),
      );
      const get = () =>
        getSource(group.resourceGroupName, lab.labName, source.artifactSourceName);
      const observed = yield* get();
      expect(observed.properties?.uri).toEqual(
        "https://github.com/Azure/azure-devtestlab.git",
      );
      expect(observed.properties?.status).toEqual("Enabled");
      expect(observed.tags?.["alchemy::id"]).toEqual("Artifacts");

      // In-place: status + display name.
      const updated = yield* stack.deploy(
        program({ status: "Disabled", displayName: "Renamed" }),
      );
      expect(updated.source.artifactSourceId).toEqual(source.artifactSourceId);
      const reobserved = yield* get();
      expect(reobserved.properties?.status).toEqual("Disabled");
      expect(reobserved.properties?.displayName).toEqual("Renamed");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: without a token the RP rejects the source with a typed
// error. Free lab; ~5 minutes.
test.provider(
  "an artifact source without a token is rejected with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group, lab } = yield* stack.deploy(labFixture());
      const error = yield* devtestlabs
        .ArtifactSourcesCreateOrUpdate({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          labName: lab.labName,
          name: "probe",
          location: lab.location,
          properties: {
            uri: "https://github.com/Azure/azure-devtestlab.git",
            sourceType: "GitHub",
            folderPath: "/Artifacts",
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("MissingRequiredProperty");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
