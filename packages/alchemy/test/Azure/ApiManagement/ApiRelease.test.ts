import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  consumptionApi,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRelease = (
  resourceGroupName: string,
  serviceName: string,
  apiId: string,
  releaseId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetApiRelease({
      subscriptionId,
      resourceGroupName,
      serviceName,
      apiId,
      releaseId,
    }),
  );

const program = (release?: { name: string; notes: string }) =>
  Effect.gen(function* () {
    const { group, service, api } = yield* consumptionApi;
    const created = release
      ? yield* Azure.ApiManagement.ApiRelease("Release", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          apiName: api.apiName,
          name: release.name,
          notes: release.notes,
        })
      : undefined;
    return { group, service, api, release: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, update, replace, and delete an API release",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ name: "alchemy-r1", notes: "Initial release" }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      const api = first.api.apiName;
      expect(first.release?.releaseName).toEqual("alchemy-r1");
      expect(
        (yield* getRelease(rg, svc, api, "alchemy-r1")).properties?.notes,
      ).toEqual("Initial release");

      // In-place update of the release notes.
      yield* stack.deploy(
        program({ name: "alchemy-r1", notes: "Initial release (edited)" }),
      );
      expect(
        (yield* getRelease(rg, svc, api, "alchemy-r1")).properties?.notes,
      ).toEqual("Initial release (edited)");

      // Replacement: a new identifier creates a new release.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-r2", notes: "Second release" }),
      );
      expect(replaced.release?.releaseName).toEqual("alchemy-r2");
      expect(yield* untilGone(getRelease(rg, svc, api, "alchemy-r1"))).toEqual(
        "gone",
      );

      // Removing the resource deletes the release.
      yield* stack.deploy(program());
      expect(yield* untilGone(getRelease(rg, svc, api, "alchemy-r2"))).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
