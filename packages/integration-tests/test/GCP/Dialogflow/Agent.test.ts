import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as dialogflow from "@distilled.cloud/gcp/dialogflow_v3";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { quotaTolerant } from "./parent.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const waitUntilGone = (name: string) =>
  dialogflow.getProjectsLocationsAgents({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const agent = (props: { timeZone: string; description: string }) =>
  GCP.Dialogflow.Agent("Support", {
    displayName: "alchemy-support",
    ...props,
  });

test.provider(
  "getProjectsLocationsAgents on a missing agent fails with NotFound",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dialogflow.getProjectsLocationsAgents({
          name: `projects/${project}/locations/global/agents/00000000-0000-0000-0000-000000000000`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel, quotaTolerant),
  { tags: ["provider:gcp", "provider:gcp:dialogflow", "live"], timeout: 90_000 },
);

test.provider(
  "create, update in place, and delete an agent",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        agent({ timeZone: "America/Los_Angeles", description: "answers support questions" }),
      );
      expect(created.name).toContain("/agents/");
      expect(created.location).toEqual("global");
      expect(created.displayName).toEqual("alchemy-support");
      expect(created.defaultLanguageCode).toEqual("en");
      expect(created.description).toEqual("answers support questions");
      expect(created.startFlow).toContain("/flows/");

      const fetched = yield* dialogflow.getProjectsLocationsAgents({ name: created.name });
      expect(fetched.timeZone).toEqual("America/Los_Angeles");
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("answers support questions");

      const updated = yield* stack.deploy(
        agent({ timeZone: "Europe/Paris", description: "answers billing questions" }),
      );
      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("answers billing questions");

      const refetched = yield* dialogflow.getProjectsLocationsAgents({ name: created.name });
      expect(refetched.timeZone).toEqual("Europe/Paris");
      expect(refetched.description).toContain("answers billing questions");

      // Redeploying the same props changes nothing.
      const plan = yield* stack.plan(
        agent({ timeZone: "Europe/Paris", description: "answers billing questions" }),
      );
      expect(plan.resources.Support?.action).toEqual("noop");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel, quotaTolerant),
  { tags: ["provider:gcp", "provider:gcp:dialogflow", "live"], timeout: 300_000 },
);
