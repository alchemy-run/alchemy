import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as registry from "@distilled.cloud/gcp/apigeeregistry_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  hasGcpCreds,
  location,
  logLevel,
  probeTags,
  project,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  registry.getProjectsLocationsApisDeployments({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsApisDeployments on a missing deployment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        registry.getProjectsLocationsApisDeployments({
          name: `projects/${project}/locations/${location}/apis/missing/deployments/alchemy-missing`,
        }),
      );
      expect(probeTags).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an API deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* GCP.Apigeeregistry.Api("Pets", {
            location,
            displayName: "pets",
          });
          const deployment = yield* GCP.Apigeeregistry.ApisDeployment(
            "Staging",
            {
              api: api.name,
              displayName: "staging",
              endpointUri: "https://pets.example.com",
              labels: { env: "test" },
            },
          );
          return { api, deployment };
        }),
      );

      expect(created.deployment.name).toContain("/deployments/");
      expect(created.deployment.api).toEqual(created.api.name);
      expect(created.deployment.displayName).toEqual("staging");
      expect(created.deployment.endpointUri).toEqual(
        "https://pets.example.com",
      );
      expect(created.deployment.labels).toMatchObject({ env: "test" });

      const fetched = yield* registry.getProjectsLocationsApisDeployments({
        name: created.deployment.name,
      });
      expect(fetched.name).toEqual(created.deployment.name);
      expect(fetched.endpointUri).toEqual("https://pets.example.com");
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* GCP.Apigeeregistry.Api("Pets", {
            apiId: created.api.apiId,
            location,
            displayName: "pets",
          });
          const deployment = yield* GCP.Apigeeregistry.ApisDeployment(
            "Staging",
            {
              api: api.name,
              deploymentId: created.deployment.deploymentId,
              displayName: "staging-v2",
              endpointUri: "https://pets-v2.example.com",
              description: "updated",
              labels: { env: "prod" },
            },
          );
          return { api, deployment };
        }),
      );

      expect(updated.deployment.name).toEqual(created.deployment.name);
      expect(updated.deployment.displayName).toEqual("staging-v2");
      expect(updated.deployment.endpointUri).toEqual(
        "https://pets-v2.example.com",
      );
      expect(updated.deployment.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.deployment.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
