import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as appengine from "@distilled.cloud/gcp/appengine_v1";
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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_APPENGINE;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (appsId: string, priority: number) =>
  appengine
    .getAppsFirewallIngressRules({
      appsId,
      ingressRulesId: String(priority),
    })
    .pipe(
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
  "getAppsFirewallIngressRules on a missing rule fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        appengine.getAppsFirewallIngressRules({
          appsId: project,
          ingressRulesId: "999999998",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_APPENGINE)(
  "createAppsFirewallIngressRules without an App Engine app fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        appengine.createAppsFirewallIngressRules({
          appsId: project,
          body: {
            action: "DENY",
            sourceRange: "203.0.113.0/24",
            description: "Alchemy Appengine Probe",
            priority: 12345,
          },
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a firewall ingress rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Appengine.AppsFirewallIngressRule("BlockOffice", {
            action: "DENY",
            sourceRange: "203.0.113.0/24",
            description: "office network",
          });
        }),
      );

      expect(created.priority).toBeGreaterThan(0);
      expect(created.action).toEqual("DENY");
      expect(created.sourceRange).toEqual("203.0.113.0/24");
      expect(created.description).toEqual("office network");

      const fetched = yield* appengine.getAppsFirewallIngressRules({
        appsId: created.appsId,
        ingressRulesId: String(created.priority),
      });
      expect(fetched.priority).toEqual(created.priority);
      expect(fetched.description).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Appengine.AppsFirewallIngressRule("BlockOffice", {
            priority: created.priority,
            action: "ALLOW",
            sourceRange: "203.0.113.0/24",
            description: "office network allow",
          });
        }),
      );

      expect(updated.priority).toEqual(created.priority);
      expect(updated.action).toEqual("ALLOW");
      expect(updated.description).toEqual("office network allow");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.appsId, created.priority);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
