import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as compute from "@distilled.cloud/gcp/compute_v1";
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
  hasGcpCreds &&
  !!process.env.GCP_TEST_VM_EXTENSION_POLICY &&
  !process.env.FAST;

const waitUntilGone = (project: string, globalVmExtensionPolicy: string) =>
  compute
    .getGlobalVmExtensionPolicies({ project, globalVmExtensionPolicy })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "probe insertGlobalVmExtensionPolicies entitlement",
  () =>
    Effect.gen(function* () {
      const project = process.env.GOOGLE_PROJECT_ID ?? "";
      const result = yield* compute
        .insertGlobalVmExtensionPolicies({
          project,
          body: {
            name: "alchemy-vep-probe",
            description: "alchemy entitlement probe",
            extensionPolicies: { "ops-agent": {} },
            rolloutOperation: {
              rolloutInput: { predefinedRolloutPlan: "FAST_ROLLOUT" },
            },
          },
        })
        .pipe(
          Effect.map(() => ({ tag: "ok" as const })),
          Effect.catchTag("Forbidden", (error) =>
            Effect.succeed({
              tag: "Forbidden" as const,
              message: error.message,
            }),
          ),
          Effect.catchTag("BadRequest", (error) =>
            Effect.succeed({
              tag: "BadRequest" as const,
              message: error.message,
            }),
          ),
        );
      if (result.tag === "ok") {
        yield* compute
          .deleteGlobalVmExtensionPolicies({
            project,
            globalVmExtensionPolicy: "alchemy-vep-probe",
            body: { predefinedRolloutPlan: "FAST_ROLLOUT" },
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        return;
      }
      expect(["Forbidden", "BadRequest"]).toContain(result.tag);
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a global VM extension policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.GlobalVmExtensionPolicy("Ops", {
            description: "ops agent",
            extensionPolicies: { "ops-agent": {} },
            rolloutOperation: {
              rolloutInput: { predefinedRolloutPlan: "FAST_ROLLOUT" },
            },
            priority: 10,
          });
        }),
      );

      expect(created.policyName).toEqual(expect.any(String));
      expect(created.description).toEqual("ops agent");
      expect(created.priority).toEqual(10);

      const fetched = yield* compute.getGlobalVmExtensionPolicies({
        project: created.project,
        globalVmExtensionPolicy: created.policyName,
      });
      expect(fetched.name).toEqual(created.policyName);
      expect(fetched.description).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.GlobalVmExtensionPolicy("Ops", {
            policyName: created.policyName,
            description: "updated ops agent",
            extensionPolicies: { "ops-agent": {} },
            rolloutOperation: {
              rolloutInput: { predefinedRolloutPlan: "FAST_ROLLOUT" },
            },
            priority: 20,
          });
        }),
      );
      expect(updated.description).toEqual("updated ops agent");
      expect(updated.priority).toEqual(20);

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.project, created.policyName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
