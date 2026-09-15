import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dialogflow from "@distilled.cloud/gcp/dialogflow_v3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { deleteAgent, ensureAgent } from "./parent.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const runLifecycle =
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_DIALOGFLOW;
const project = process.env.GOOGLE_PROJECT_ID ?? "";
const agentDisplayName = "alch-df-pbk";

const waitUntilGone = (name: string) =>
  dialogflow.getProjectsLocationsAgentsPlaybooks({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsAgentsPlaybooks on a missing playbook fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dialogflow.getProjectsLocationsAgentsPlaybooks({
          name: `projects/${project}/locations/global/agents/missing/playbooks/missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a playbook",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const agent = yield* ensureAgent(project, agentDisplayName);
      const agentName = agent.name ?? "";

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dialogflow.AgentsPlaybook("Support", {
            agent: agentName,
            displayName: "support",
            goal: "Answer the user's support question.",
          });
        }),
      );

      expect(created.name).toContain("/playbooks/");
      expect(created.agent).toEqual(agentName);
      expect(created.displayName).toEqual("support");
      expect(created.goal).toEqual("Answer the user's support question.");

      const fetched = yield* dialogflow.getProjectsLocationsAgentsPlaybooks({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dialogflow.AgentsPlaybook("Support", {
            agent: agentName,
            playbookId: created.playbookId,
            displayName: "support",
            goal: "Reset the user's password.",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.goal).toEqual("Reset the user's password.");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");

      yield* deleteAgent(agentName);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
