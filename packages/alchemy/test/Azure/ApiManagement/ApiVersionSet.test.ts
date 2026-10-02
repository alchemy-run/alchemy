import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  consumptionService,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getVersionSet = (
  resourceGroupName: string,
  serviceName: string,
  versionSetId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetApiVersionSet({
      subscriptionId,
      resourceGroupName,
      serviceName,
      versionSetId,
    }),
  );

const program = (set?: {
  name: string;
  displayName: string;
  scheme: Azure.ApiManagement.VersioningScheme;
}) =>
  Effect.gen(function* () {
    const { group, service } = yield* consumptionService;
    const created = set
      ? yield* Azure.ApiManagement.ApiVersionSet("Versions", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          name: set.name,
          displayName: set.displayName,
          versioningScheme: set.scheme,
          versionHeaderName:
            set.scheme === "Header" ? "api-version" : undefined,
          description: "Hello versions",
        })
      : undefined;
    return { group, service, set: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, update, replace, and delete an API version set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({
          name: "alchemy-versions",
          displayName: "Hello",
          scheme: "Segment",
        }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.set?.versionSetName).toEqual("alchemy-versions");
      expect(first.set?.versionSetId).toContain(
        "/apiVersionSets/alchemy-versions",
      );
      const observed = yield* getVersionSet(rg, svc, "alchemy-versions");
      expect(observed.properties?.displayName).toEqual("Hello");
      expect(observed.properties?.versioningScheme).toEqual("Segment");
      expect(observed.properties?.description).toEqual("Hello versions");

      // In-place update: display name and versioning scheme.
      yield* stack.deploy(
        program({
          name: "alchemy-versions",
          displayName: "Hello API",
          scheme: "Header",
        }),
      );
      const updated = yield* getVersionSet(rg, svc, "alchemy-versions");
      expect(updated.properties?.displayName).toEqual("Hello API");
      expect(updated.properties?.versioningScheme).toEqual("Header");
      expect(updated.properties?.versionHeaderName).toEqual("api-version");

      // Replacement: a new identifier creates a new set and deletes the old.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-versions-v2",
          displayName: "Hello API",
          scheme: "Header",
        }),
      );
      expect(replaced.set?.versionSetName).toEqual("alchemy-versions-v2");
      expect(
        (yield* getVersionSet(rg, svc, "alchemy-versions-v2")).properties
          ?.displayName,
      ).toEqual("Hello API");
      expect(
        yield* untilGone(getVersionSet(rg, svc, "alchemy-versions")),
      ).toEqual("gone");

      // Removing the resource deletes the version set.
      yield* stack.deploy(program());
      expect(
        yield* untilGone(getVersionSet(rg, svc, "alchemy-versions-v2")),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
