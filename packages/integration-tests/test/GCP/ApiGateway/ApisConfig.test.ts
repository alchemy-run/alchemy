import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as apigateway from "@distilled.cloud/gcp/apigateway_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// API create and delete take ~2–3 minutes each, and a config about as long.
const runLifecycle = !process.env.FAST;
const parentOf = (project: string) => `projects/${project}/locations/global`;

const openApi = `swagger: "2.0"
info:
  title: alchemy-apigateway-test
  description: alchemy test
  version: "1.0.0"
schemes:
  - https
produces:
  - application/json
paths:
  /hello:
    get:
      summary: hello
      operationId: helloGet
      x-google-backend:
        address: https://httpbin.org/get
      responses:
        "200":
          description: A successful response
`;

const waitUntilGone = (name: string) =>
  apigateway.getProjectsLocationsApisConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsApisConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      const parent = parentOf(project);
      yield* stack.destroy();

      const error = yield* Effect.flip(
        apigateway.getProjectsLocationsApisConfigs({
          name: `${parent}/apis/missing/configs/alchemy-missing-config`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:apigateway", "live"],
    timeout: 90_000,
  },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an API Gateway API config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const parent = yield* GCP.ApiGateway.Api("Parent", {});
          const config = yield* GCP.ApiGateway.ApisConfig("V1", {
            api: parent.name,
            displayName: "v1",
            openapiDocuments: [
              {
                document: {
                  path: "openapi.yaml",
                  contents: openApi,
                },
              },
            ],
            labels: { env: "test" },
          });
          return { parent, config };
        }),
      );
      const api = created.parent.name;
      expect(created.parent.state).toEqual("ACTIVE");

      const config = created.config;
      expect(config.apiConfigId).toEqual(expect.any(String));
      expect(config.api).toEqual(api);
      expect(config.location).toEqual("global");
      expect(config.displayName).toEqual("v1");
      expect(config.labels).toMatchObject({ env: "test" });
      expect(config.name).toEqual(`${api}/configs/${config.apiConfigId}`);

      const fetched = yield* apigateway.getProjectsLocationsApisConfigs({
        name: config.name,
        view: "FULL",
      });
      // The API reports the project number in names; the resource keeps the
      // project-id form it was addressed by.
      expect(fetched.name).toEqual(
        expect.stringMatching(new RegExp(`/apis/[^/]+/configs/${config.apiConfigId}$`)),
      );
      expect(fetched.displayName).toEqual("v1");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const parent = yield* GCP.ApiGateway.Api("Parent", {});
          return yield* GCP.ApiGateway.ApisConfig("V1", {
            api: parent.name,
            apiConfigId: config.apiConfigId,
            displayName: "v1-prod",
            openapiDocuments: [
              {
                document: {
                  path: "openapi.yaml",
                  contents: openApi,
                },
              },
            ],
            labels: { env: "prod", team: "gateway" },
          });
        }),
      );

      expect(updated.name).toEqual(config.name);
      expect(updated.displayName).toEqual("v1-prod");
      expect(updated.labels).toMatchObject({ env: "prod", team: "gateway" });

      const fetchedUpdate = yield* apigateway.getProjectsLocationsApisConfigs({
        name: updated.name,
      });
      expect(fetchedUpdate.displayName).toEqual("v1-prod");
      expect(fetchedUpdate.labels?.team).toEqual("gateway");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(config.name);
      expect(gone).toEqual("gone");
      const parentGone = yield* apigateway.getProjectsLocationsApis({ name: api }).pipe(
        Effect.as("found" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      );
      expect(parentGone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:apigateway", "live"],
    timeout: 900_000,
    retry: 0,
  },
);
