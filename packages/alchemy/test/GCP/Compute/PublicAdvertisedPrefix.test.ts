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

const ipCidrRange = process.env.GCP_TEST_PAP_RANGE ?? "203.0.113.0/24";
const dnsVerificationIp = process.env.GCP_TEST_PAP_DNS_IP ?? "203.0.113.1";

const waitUntilGone = (project: string, publicAdvertisedPrefix: string) =>
  compute.getPublicAdvertisedPrefixes({ project, publicAdvertisedPrefix }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "probe insertPublicAdvertisedPrefixes entitlement",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const project = process.env.GOOGLE_PROJECT_ID ?? "";
      const result = yield* compute
        .insertPublicAdvertisedPrefixes({
          project,
          body: {
            name: "alchemy-pap-probe",
            description: "alchemy entitlement probe",
            ipCidrRange,
            dnsVerificationIp,
            pdpScope: "REGIONAL",
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
          Effect.catchTag("Conflict", (error) =>
            Effect.succeed({
              tag: "Conflict" as const,
              message: error.message,
            }),
          ),
        );
      if (result.tag === "ok") {
        yield* compute
          .deletePublicAdvertisedPrefixes({
            project,
            publicAdvertisedPrefix: "alchemy-pap-probe",
          })
          .pipe(
            Effect.catchTag("NotFound", () => Effect.void),
            Effect.catchTag("BadRequest", () => Effect.void),
            Effect.catchTag("Forbidden", () => Effect.void),
          );
      } else {
        expect(["Forbidden", "BadRequest", "NotFound", "Conflict"]).toContain(
          result.tag,
        );
      }
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 60_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a public advertised prefix",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.PublicAdvertisedPrefix("Byoip", {
            ipCidrRange,
            dnsVerificationIp,
            pdpScope: "REGIONAL",
            description: "lab prefix",
          });
        }),
      );

      expect(created.prefixName).toEqual(expect.any(String));
      expect(created.ipCidrRange).toEqual(ipCidrRange);
      expect(created.description).toEqual("lab prefix");

      const fetched = yield* compute.getPublicAdvertisedPrefixes({
        project: created.project,
        publicAdvertisedPrefix: created.prefixName,
      });
      expect(fetched.name).toEqual(created.prefixName);
      expect(fetched.description).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Compute.PublicAdvertisedPrefix("Byoip", {
            prefixName: created.prefixName,
            ipCidrRange,
            dnsVerificationIp,
            pdpScope: "REGIONAL",
            description: "updated prefix",
          });
        }),
      );

      expect(updated.prefixName).toEqual(created.prefixName);
      expect(updated.description).toEqual("updated prefix");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.project, created.prefixName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
