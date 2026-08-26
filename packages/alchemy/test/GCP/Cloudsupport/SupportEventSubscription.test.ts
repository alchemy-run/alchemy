import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudsupport from "@distilled.cloud/gcp/cloudsupport_v2";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
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

const project = process.env.GOOGLE_PROJECT_ID ?? "alchemy-gcp-testing-83661";
const entitlementTags = ["Forbidden", "NotFound", "BadRequest"] as const;

// Cloud Support Event Subscriptions are entitlement-gated on the default
// testing project (`Forbidden`: "Google Cloud Support API has not been
// used in project 457525637530 before or it is disabled."). Set
// GCP_TEST_CLOUDSUPPORT=1 on an entitled org (Cloud Customer Care) to run
// the lifecycle.
const entitled = process.env.GCP_TEST_CLOUDSUPPORT === "1";
const runLifecycle = hasGcpCreds && entitled && !process.env.FAST;

const waitUntilGone = (name: string) =>
  cloudsupport.getSupportEventSubscriptions({ name }).pipe(
    Effect.map((subscription) =>
      subscription.state === "DELETED" ? ("gone" as const) : ("found" as const),
    ),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const organizationOf = () =>
  Effect.gen(function* () {
    const fromEnv = process.env.GOOGLE_ORGANIZATION_ID;
    if (fromEnv && fromEnv.length > 0) {
      return fromEnv.startsWith("organizations/")
        ? fromEnv
        : `organizations/${fromEnv}`;
    }
    let current: string | undefined = `projects/${project}`;
    for (let i = 0; i < 8; i++) {
      if (current === undefined) return "";
      if (current.startsWith("organizations/")) return current;
      current = current.startsWith("projects/")
        ? yield* resourcemanager.getProjects({ name: current }).pipe(
            Effect.map((resource) => resource.parent),
            Effect.catchTag(["NotFound", "Forbidden"], () =>
              Effect.succeed(undefined),
            ),
          )
        : current.startsWith("folders/")
          ? yield* resourcemanager.getFolders({ name: current }).pipe(
              Effect.map((folder) => folder.parent),
              Effect.catchTag(["NotFound", "Forbidden"], () =>
                Effect.succeed(undefined),
              ),
            )
          : undefined;
    }
    return "";
  });

const assertDisabledOrMissing = (error: { _tag: string; message?: string }) => {
  expect([...entitlementTags]).toContain(error._tag);
  if (error._tag === "Forbidden") {
    expect(error.message ?? "").toContain("Google Cloud Support API");
  }
};

test.provider.skipIf(!hasGcpCreds)(
  "getSupportEventSubscriptions on a missing subscription fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = (yield* organizationOf()) || "organizations/0";
      const error = yield* Effect.flip(
        cloudsupport.getSupportEventSubscriptions({
          name: `${organization}/supportEventSubscriptions/alchemy-missing`,
        }),
      );
      assertDisabledOrMissing(error);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "createSupportEventSubscriptions without Cloud Support access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = (yield* organizationOf()) || "organizations/0";
      const error = yield* Effect.flip(
        cloudsupport.createSupportEventSubscriptions({
          parent: organization,
          body: {
            pubSubTopic: `projects/${project}/topics/alchemy-missing-topic`,
          },
        }),
      );
      assertDisabledOrMissing(error);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a support event subscription",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const organization = yield* organizationOf();
      expect(organization.length).toBeGreaterThan(0);

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("SupportEventsA", {});
          const subscription = yield* GCP.Cloudsupport.SupportEventSubscription(
            "Events",
            {
              organization,
              pubSubTopic: topic.name,
            },
          );
          return { topic, subscription };
        }),
      );

      expect(created.subscription.name).toContain(
        "/supportEventSubscriptions/",
      );
      expect(created.subscription.subscriptionId.length).toBeGreaterThan(0);
      expect(created.subscription.organization).toEqual(organization);
      expect(created.subscription.pubSubTopic).toEqual(created.topic.name);

      const fetched = yield* cloudsupport.getSupportEventSubscriptions({
        name: created.subscription.name,
      });
      expect(fetched.name).toEqual(created.subscription.name);
      expect(fetched.pubSubTopic).toEqual(created.topic.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const topicA = yield* GCP.PubSub.Topic("SupportEventsA", {});
          const topicB = yield* GCP.PubSub.Topic("SupportEventsB", {});
          const subscription = yield* GCP.Cloudsupport.SupportEventSubscription(
            "Events",
            {
              organization,
              subscriptionId: created.subscription.subscriptionId,
              pubSubTopic: topicB.name,
            },
          );
          return { topicA, topicB, subscription };
        }),
      );

      expect(updated.subscription.name).toEqual(created.subscription.name);
      expect(updated.subscription.pubSubTopic).toEqual(updated.topicB.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.subscription.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
