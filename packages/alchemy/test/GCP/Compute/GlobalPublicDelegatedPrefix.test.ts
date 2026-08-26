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
  hasGcpCreds && !!process.env.GCP_TEST_BYOIP && !process.env.FAST;

const parentPrefix = process.env.GCP_TEST_PAP_PARENT ?? "";
const ipCidrRange = process.env.GCP_TEST_PDP_RANGE ?? "203.0.113.0/24";

const waitUntilGone = (project: string, publicDelegatedPrefix: string) =>
  compute
    .getGlobalPublicDelegatedPrefixes({ project, publicDelegatedPrefix })
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
  "probe insertGlobalPublicDelegatedPrefixes entitlement",
  () =>
    Effect.gen(function* () {
      const project = process.env.GOOGLE_PROJECT_ID ?? "";
      const result = yield* compute
        .insertGlobalPublicDelegatedPrefixes({
          project,
          body: {
            name: "alchemy-pdp-probe",
            description: "alchemy entitlement probe",
            parentPrefix: parentPrefix || "does-not-exist",
            ipCidrRange,
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
          Effect.catchTag("NotFound", (error) =>
            Effect.succeed({
              tag: "NotFound" as const,
              message: error.message,
            }),
          ),
        );
      if (result.tag === "ok") {
        yield* compute
          .deleteGlobalPublicDelegatedPrefixes({
            project,
            publicDelegatedPrefix: "alchemy-pdp-probe",
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        return;
      }
      expect(["Forbidden", "BadRequest", "NotFound"]).toContain(result.tag);
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider.skipIf(!runLifecycle || !parentPrefix)(
  "create, update, and delete a global public delegated prefix",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.GlobalPublicDelegatedPrefix("Byoip", {
            parentPrefix,
            ipCidrRange,
            description: "delegated range",
          });
        }),
      );

      expect(created.prefixName).toEqual(expect.any(String));
      expect(created.ipCidrRange).toEqual(ipCidrRange);
      expect(created.description).toEqual("delegated range");

      const fetched = yield* compute.getGlobalPublicDelegatedPrefixes({
        project: created.project,
        publicDelegatedPrefix: created.prefixName,
      });
      expect(fetched.name).toEqual(created.prefixName);
      expect(fetched.description).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.GlobalPublicDelegatedPrefix("Byoip", {
            prefixName: created.prefixName,
            parentPrefix,
            ipCidrRange,
            description: "updated range",
          });
        }),
      );
      expect(updated.description).toEqual("updated range");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.project, created.prefixName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
