import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as we from "@distilled.cloud/gcp/workspaceevents_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_WORKSPACE_EVENTS;

const waitUntilGone = (name: string) =>
  we.getSubscriptions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getSubscriptions on a missing subscription fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        we.getSubscriptions({
          name: "subscriptions/alchemy-missing-subscription",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_WORKSPACE_EVENTS)(
  "createSubscriptions without Workspace Events access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        we.createSubscriptions({
          body: {
            targetResource: "//chat.googleapis.com/spaces/alchemy-missing",
            eventTypes: ["google.workspace.chat.message.v1.created"],
            notificationEndpoint: {
              pubsubTopic: `projects/${process.env.GOOGLE_PROJECT_ID}/topics/alchemy-missing-topic`,
            },
          },
        }),
      );
      expect(["Forbidden", "BadRequest", "NotFound"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a Workspace Events subscription",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const targetResource =
        process.env.GCP_TEST_WORKSPACE_EVENTS_TARGET ??
        "//chat.googleapis.com/spaces/-";

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("WorkspaceEvents", {});
          const subscription = yield* GCP.Workspaceevents.Subscription(
            "SpaceEvents",
            {
              targetResource,
              eventTypes: ["google.workspace.chat.message.v1.created"],
              pubsubTopic: topic.name,
              ttl: "3600s",
            },
          );
          return { topic, subscription };
        }),
      );

      expect(created.subscription.name.startsWith("subscriptions/")).toEqual(
        true,
      );
      expect(created.subscription.subscriptionId.length).toBeGreaterThan(0);
      expect(created.subscription.targetResource).toEqual(targetResource);
      expect(created.subscription.eventTypes).toContain(
        "google.workspace.chat.message.v1.created",
      );

      const fetched = yield* we.getSubscriptions({
        name: created.subscription.name,
      });
      expect(fetched.name).toEqual(created.subscription.name);
      expect(fetched.notificationEndpoint?.pubsubTopic).toEqual(
        created.topic.name,
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("WorkspaceEvents", {});
          const subscription = yield* GCP.Workspaceevents.Subscription(
            "SpaceEvents",
            {
              subscriptionId: created.subscription.subscriptionId,
              targetResource,
              eventTypes: [
                "google.workspace.chat.message.v1.created",
                "google.workspace.chat.message.v1.updated",
              ],
              pubsubTopic: topic.name,
              ttl: "7200s",
            },
          );
          return { topic, subscription };
        }),
      );

      expect(updated.subscription.name).toEqual(created.subscription.name);
      expect(updated.subscription.eventTypes).toEqual(
        expect.arrayContaining([
          "google.workspace.chat.message.v1.created",
          "google.workspace.chat.message.v1.updated",
        ]),
      );

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.subscription.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
