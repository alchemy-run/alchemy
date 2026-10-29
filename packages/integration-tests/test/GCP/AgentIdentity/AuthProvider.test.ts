import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as agentidentity from "@distilled.cloud/gcp/agentidentity_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const location = "us-central1";

// The testing project doesn't enable Agent Identity by default: the stack
// enables it first.
const AgentIdentityApi = GCP.ServiceUsage.ProjectService("AgentIdentityApi", {
  service: "agentidentity.googleapis.com",
});

const waitUntilGone = (name: string) =>
  agentidentity.getProjectsLocationsAuthProviders({ name }).pipe(
    Effect.map((item) => (item.deleted === true ? ("gone" as const) : ("found" as const))),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "getProjectsLocationsAuthProviders on a missing provider fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();
      yield* stack.deploy(AgentIdentityApi);

      const error = yield* Effect.flip(
        agentidentity.getProjectsLocationsAuthProviders({
          name: `projects/${project}/locations/${location}/authProviders/alchemy-missing-auth`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:agentidentity", "live"],
    timeout: 90_000,
  },
);

test.provider(
  "create, update, and delete an Agent Identity auth provider",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* stack.deploy(AgentIdentityApi);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          yield* AgentIdentityApi;
          return yield* GCP.AgentIdentity.AuthProvider("Maps", {
            location,
            description: "alchemy maps key",
            labels: { env: "test" },
            authProviderTypeParams: {
              apiKey: { apiKey: "alchemy-test-api-key" },
            },
          });
        }),
      );

      expect(created.name).toContain("/authProviders/");
      expect(created.authProviderId).toEqual(expect.any(String));
      expect(created.location).toEqual(location);
      expect(created.description).toEqual("alchemy maps key");
      expect(created.disabled).toEqual(false);
      expect(created.authProviderTypeParams?.apiKey).toBeDefined();

      const fetched = yield* agentidentity.getProjectsLocationsAuthProviders({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      // Ownership rides in the description (the API drops labels).
      expect(fetched.description).toMatch(/^\[alchemy .*\]\nalchemy maps key$/);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          yield* AgentIdentityApi;
          return yield* GCP.AgentIdentity.AuthProvider("Maps", {
            authProviderId: created.authProviderId,
            location,
            description: "alchemy maps key v2",
            labels: { env: "prod", role: "maps" },
            authProviderTypeParams: {
              apiKey: { apiKey: "alchemy-test-api-key" },
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.authProviderId).toEqual(created.authProviderId);
      expect(updated.description).toEqual("alchemy maps key v2");

      const fetchedUpdate = yield* agentidentity.getProjectsLocationsAuthProviders({
        name: created.name,
      });
      expect(fetchedUpdate.description).toMatch(/\nalchemy maps key v2$/);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:agentidentity", "live"],
    timeout: 90_000,
  },
);
