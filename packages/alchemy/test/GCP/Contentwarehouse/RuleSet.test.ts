import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cw from "@distilled.cloud/gcp/contentwarehouse_v1";
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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_CONTENTWAREHOUSE;

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const location = "us";
const parent = `projects/${project}/locations/${location}`;

const waitUntilGone = (name: string) =>
  cw.getProjectsLocationsRuleSets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsRuleSets on a missing rule set fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cw.getProjectsLocationsRuleSets({
          name: `${parent}/ruleSets/alchemy-missing-ruleset`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a rule set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* cw
        .listProjectsLocationsRuleSets({
          parent,
          pageSize: 1,
        })
        .pipe(
          Effect.map(() => ({ tag: "ok" as const })),
          Effect.catchTag("Forbidden", (error) =>
            Effect.succeed({
              tag: "Forbidden" as const,
              message: error.message,
            }),
          ),
          Effect.catchTag("NotFound", (error) =>
            Effect.succeed({
              tag: "NotFound" as const,
              message: error.message,
            }),
          ),
        );
      if (probe.tag !== "ok") {
        expect(["Forbidden", "NotFound"]).toContain(probe.tag);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Contentwarehouse.RuleSet("Checks", {
            location,
            description: "on create",
            source: "alchemy",
            rules: [
              {
                description: "require title",
                triggerType: "ON_CREATE",
                condition: "true",
                actions: [
                  {
                    dataValidation: {
                      conditions: { display_name: "true" },
                    },
                  },
                ],
              },
            ],
          });
        }),
      );

      expect(created.ruleSetId).toEqual(expect.any(String));
      expect(created.name).toContain("/ruleSets/");
      expect(created.description).toEqual("on create");
      expect(created.source).toEqual("alchemy");
      expect((created.rules ?? []).length).toBeGreaterThan(0);

      const fetched = yield* cw.getProjectsLocationsRuleSets({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("on create");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Contentwarehouse.RuleSet("Checks", {
            ruleSetId: created.ruleSetId,
            location,
            description: "on update",
            source: "alchemy-v2",
            rules: [
              {
                description: "require title",
                triggerType: "ON_UPDATE",
                condition: "true",
                actions: [
                  {
                    dataValidation: {
                      conditions: { display_name: "true" },
                    },
                  },
                ],
              },
            ],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("on update");
      expect(updated.source).toEqual("alchemy-v2");
      expect(updated.rules?.[0]?.triggerType).toEqual("ON_UPDATE");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
