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
const location = "us-central1";
const agentDisplayName = "alch-df-atrg";

const waitUntilGone = (name: string) =>
  dialogflow.getProjectsLocationsAgentsTransitionRouteGroups({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsAgentsTransitionRouteGroups on a missing group fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dialogflow.getProjectsLocationsAgentsTransitionRouteGroups({
          name: `projects/${project}/locations/${location}/agents/missing/transitionRouteGroups/missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an agent transition route group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const agent = yield* ensureAgent(project, agentDisplayName, location);
      const agentName = agent.name ?? "";

      yield* Effect.gen(function* () {
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Dialogflow.AgentsTransitionRouteGroup(
              "Fallback",
              {
                agent: agentName,
                location,
                displayName: "g1",
                transitionRoutes: [
                  {
                    condition: "true",
                    triggerFulfillment: {
                      messages: [{ text: { text: ["ok"] } }],
                    },
                  },
                ],
              },
            );
          }),
        );

        expect(created.name).toContain("/transitionRouteGroups/");
        expect(created.name).not.toContain("/flows/");
        expect(created.agent).toEqual(agentName);
        expect(created.location).toEqual(location);
        expect(created.displayName).toEqual("g1");
        expect(created.transitionRoutes[0]?.condition).toEqual("true");

        const fetched =
          yield* dialogflow.getProjectsLocationsAgentsTransitionRouteGroups({
            name: created.name,
          });
        expect(fetched.name).toEqual(created.name);
        expect(fetched.displayName).toContain("[alc ");

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Dialogflow.AgentsTransitionRouteGroup(
              "Fallback",
              {
                agent: agentName,
                location,
                transitionRouteGroupId: created.transitionRouteGroupId,
                displayName: "g2",
                transitionRoutes: [
                  {
                    condition: "true",
                    triggerFulfillment: {
                      messages: [{ text: { text: ["sorry"] } }],
                    },
                  },
                ],
              },
            );
          }),
        );

        expect(updated.name).toEqual(created.name);
        expect(updated.displayName).toEqual("g2");
        expect(
          updated.transitionRoutes[0]?.triggerFulfillment?.messages?.[0]?.text
            ?.text?.[0],
        ).toEqual("sorry");

        yield* stack.destroy();
        const gone = yield* waitUntilGone(created.name);
        expect(gone).toEqual("gone");
      }).pipe(Effect.ensuring(deleteAgent(agentName)));
    }).pipe(logLevel),
  { timeout: 120_000 },
);
