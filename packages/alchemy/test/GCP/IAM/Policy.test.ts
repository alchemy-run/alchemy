import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as iam from "@distilled.cloud/gcp/iam_v2";
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
  hasGcpCreds && !!process.env.GCP_TEST_IAM_DENY && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";
const attachment = encodeURIComponent(
  `cloudresourcemanager.googleapis.com/projects/${project}`,
);
const missingName = `policies/${attachment}/denypolicies/alchemy-missing`;

const waitUntilGone = (name: string) =>
  iam.getPolicies({ name }).pipe(
    Effect.map((policy) =>
      policy.deleteTime ? ("gone" as const) : ("found" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 8,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getPolicies on a missing deny policy fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(iam.getPolicies({ name: missingName }));
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || runLifecycle)(
  "createPolicyPolicies without deny-policy access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        iam.createPolicyPolicies({
          parent: `policies/${attachment}/denypolicies`,
          policyId: "alchemy-probe",
          body: {
            displayName: "alchemy-probe",
            rules: [
              {
                denyRule: {
                  deniedPermissions: ["iam.googleapis.com/roles.list"],
                  deniedPrincipals: [
                    "principal://goog/subject/alchemy-deny-probe@example.invalid",
                  ],
                },
              },
            ],
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a deny policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.IAM.Policy("Probe", {
            displayName: "alchemy-probe",
          });
        }),
      );

      expect(created.name).toContain("/denypolicies/");
      expect(created.policyId).toEqual(expect.any(String));
      expect(created.displayName).toEqual("alchemy-probe");

      const fetched = yield* iam.getPolicies({ name: created.name });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.annotations?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.IAM.Policy("Probe", {
            policyId: created.policyId,
            displayName: "alchemy-probe-v2",
          });
        }),
      );
      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("alchemy-probe-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
