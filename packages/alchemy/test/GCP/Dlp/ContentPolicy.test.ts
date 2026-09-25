import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dlp from "@distilled.cloud/gcp/dlp_v2";
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

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  dlp.getProjectsLocationsContentPolicies({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsContentPolicies on a missing policy fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dlp.getProjectsLocationsContentPolicies({
          name: `projects/${project}/locations/us/contentPolicies/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a content policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* dlp
        .listProjectsLocationsContentPolicies({
          parent: `projects/${project}/locations/us`,
          pageSize: 1,
        })
        .pipe(
          Effect.as("ok" as const),
          Effect.catchTag(["Forbidden", "NotFound"], (error) =>
            Effect.succeed(error._tag),
          ),
        );
      if (access !== "ok") {
        expect(["Forbidden", "NotFound"]).toContain(access);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dlp.ContentPolicy("BlockEmail", {
            location: "us",
            displayName: "email",
            inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
            rules: [
              {
                conditions: [
                  {
                    infoTypeCondition: {
                      infoTypes: { infoTypeNames: ["EMAIL_ADDRESS"] },
                    },
                  },
                ],
                action: { returnVerdict: "BLOCK" },
              },
            ],
            defaultAction: { returnVerdict: "ALLOW" },
          });
        }),
      );

      expect(created.contentPolicyId).toEqual(expect.any(String));
      expect(created.location).toEqual("us");
      expect(created.name).toContain("/contentPolicies/");
      expect(created.displayName).toEqual("email");
      expect(created.rules.length).toBeGreaterThan(0);

      const fetched = yield* dlp.getProjectsLocationsContentPolicies({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("alchemy-");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dlp.ContentPolicy("BlockEmail", {
            contentPolicyId: created.contentPolicyId,
            location: "us",
            displayName: "email2",
            inspectConfig: { infoTypes: [{ name: "EMAIL_ADDRESS" }] },
            rules: [
              {
                conditions: [
                  {
                    infoTypeCondition: {
                      infoTypes: { infoTypeNames: ["EMAIL_ADDRESS"] },
                    },
                  },
                ],
                action: { returnVerdict: "BLOCK" },
              },
            ],
            defaultAction: { returnVerdict: "ALLOW" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("email2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
