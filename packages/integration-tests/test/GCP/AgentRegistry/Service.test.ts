import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as registry from "@distilled.cloud/gcp/agentregistry_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const location = "us-central1";

const AgentRegistryApi = GCP.ServiceUsage.ProjectService("AgentRegistryApi", {
  service: "agentregistry.googleapis.com",
});

const waitUntilGone = (name: string) =>
  registry.getProjectsLocationsServices({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 15,
    }),
  );

const agent = (props: { displayName: string; url: string }) =>
  Effect.gen(function* () {
    yield* AgentRegistryApi;
    return yield* GCP.AgentRegistry.Service("Support", {
      location,
      displayName: props.displayName,
      description: "answers support questions",
      agentSpec: { type: "NO_SPEC" },
      interfaces: [{ url: props.url, protocolBinding: "HTTP_JSON" }],
    });
  });

test.provider(
  "getProjectsLocationsServices on a missing service fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();
      yield* stack.deploy(AgentRegistryApi);

      const error = yield* Effect.flip(
        registry.getProjectsLocationsServices({
          name: `projects/${project}/locations/${location}/services/alchemy-missing-service`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:agentregistry", "live"], timeout: 90_000 },
);

test.provider(
  "register an agent, update it in place, and unregister it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        agent({ displayName: "support agent", url: "https://example.com/support" }),
      );
      expect(created.name).toContain("/services/");
      expect(created.description).toEqual("answers support questions");
      expect(created.registryResource).toContain("/agents/");

      const fetched = yield* registry.getProjectsLocationsServices({ name: created.name });
      expect(fetched.description).toContain("answers support questions");
      expect(fetched.interfaces?.[0]?.url).toEqual("https://example.com/support");

      const updated = yield* stack.deploy(
        agent({ displayName: "support agent v2", url: "https://example.com/support/v2" }),
      );
      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("support agent v2");

      const refetched = yield* registry.getProjectsLocationsServices({ name: created.name });
      expect(refetched.interfaces?.[0]?.url).toEqual("https://example.com/support/v2");

      const plan = yield* stack.plan(
        agent({ displayName: "support agent v2", url: "https://example.com/support/v2" }),
      );
      expect(plan.resources.Support?.action).toEqual("noop");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:agentregistry", "live"], timeout: 300_000 },
);
