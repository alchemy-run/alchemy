import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import {
  consumptionService,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getApi = (
  resourceGroupName: string,
  serviceName: string,
  apiId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetApi({ subscriptionId, resourceGroupName, serviceName, apiId }),
  );

const listOperations = (
  resourceGroupName: string,
  serviceName: string,
  apiId: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.ListApiOperationByApi({
      subscriptionId,
      resourceGroupName,
      serviceName,
      apiId,
    }),
  );

const openApi = (title: string) =>
  JSON.stringify({
    openapi: "3.0.1",
    info: { title, version: "1.0" },
    paths: {
      "/pets": {
        get: {
          operationId: "listPets",
          responses: { "200": { description: "OK" } },
        },
      },
    },
  });

const program = (api?: {
  name: string;
  path: string;
  displayName: string;
  title: string;
}) =>
  Effect.gen(function* () {
    const { group, service } = yield* consumptionService;
    const created = api
      ? yield* Azure.ApiManagement.Api("Pets", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          name: api.name,
          path: api.path,
          displayName: api.displayName,
          serviceUrl: "https://example.com",
          format: "openapi+json",
          value: openApi(api.title),
        })
      : undefined;
    return { group, service, api: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, update, replace, and delete an imported API",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({
          name: "alchemy-pets",
          path: "pets",
          displayName: "Pets",
          title: "Pets",
        }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.api?.apiName).toEqual("alchemy-pets");
      const observed = yield* getApi(rg, svc, "alchemy-pets");
      expect(observed.properties?.path).toEqual("pets");
      expect(observed.properties?.displayName).toEqual("Pets");
      expect(observed.properties?.subscriptionRequired).toEqual(true);
      const operations = yield* listOperations(rg, svc, "alchemy-pets");
      expect(
        (operations.value ?? []).map((op) => op.properties?.urlTemplate),
      ).toEqual(["/pets"]);

      // The API is live on the gateway and demands a subscription key.
      const client = yield* HttpClient.HttpClient;
      const response = yield* client
        .get(`${first.service.gatewayUrl}/pets/pets`)
        .pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (res) => res.status === 401,
            times: 24,
          }),
        );
      expect(response.status).toEqual(401);

      // In-place update: display name and path.
      yield* stack.deploy(
        program({
          name: "alchemy-pets",
          path: "animals",
          displayName: "Animals",
          title: "Pets",
        }),
      );
      const updated = yield* getApi(rg, svc, "alchemy-pets");
      expect(updated.properties?.path).toEqual("animals");
      expect(updated.properties?.displayName).toEqual("Animals");

      // Replacement: a new identifier creates a new API and deletes the old.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-pets-v2",
          // Paths and display names are unique per service, and the
          // replacement is created before the old API is deleted.
          path: "animals-v2",
          displayName: "Animals v2",
          title: "Pets",
        }),
      );
      expect(replaced.api?.apiName).toEqual("alchemy-pets-v2");
      expect(
        (yield* getApi(rg, svc, "alchemy-pets-v2")).properties?.path,
      ).toEqual("animals-v2");
      expect(yield* untilGone(getApi(rg, svc, "alchemy-pets"))).toEqual("gone");

      // Removing the API deletes it while the service stays.
      yield* stack.deploy(program());
      expect(yield* untilGone(getApi(rg, svc, "alchemy-pets-v2"))).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
