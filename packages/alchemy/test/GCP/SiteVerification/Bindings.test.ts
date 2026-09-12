import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as siteVerification from "@distilled.cloud/gcp/siteVerification_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

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

const probeAccess = () =>
  siteVerification.listWebResource({}).pipe(
    Effect.as("ok" as const),
    Effect.catchTag(["Forbidden", "NotFound", "Unauthorized"], (error) =>
      Effect.succeed(error._tag),
    ),
  );

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "GetWebResource round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeAccess();
      if (access !== "ok") {
        expect(["Forbidden", "NotFound", "Unauthorized"]).toContain(access);
        yield* stack.destroy();
        return;
      }

      const identifier = "https://alchemy-site-verification.test/";
      const probe = yield* siteVerification
        .insertWebResource({
          verificationMethod: "FILE",
          body: { site: { identifier, type: "SITE" } },
        })
        .pipe(
          Effect.map((resource) => ({
            _tag: "ok" as const,
            id: resource.id,
          })),
          Effect.catchTag(
            ["BadRequest", "Forbidden", "Unauthorized", "NotFound", "Conflict"],
            (error) => Effect.succeed({ _tag: error._tag, id: undefined }),
          ),
        );

      if (probe._tag !== "ok") {
        expect([
          "BadRequest",
          "Forbidden",
          "Unauthorized",
          "NotFound",
          "Conflict",
        ]).toContain(probe._tag);
        yield* stack.destroy();
        return;
      }

      if (probe.id) {
        yield* siteVerification
          .deleteWebResource({ id: decodeURIComponent(probe.id) })
          .pipe(
            Effect.catchTag(
              [
                "NotFound",
                "Forbidden",
                "Unauthorized",
                "BadRequest",
                "Conflict",
              ],
              () => Effect.void,
            ),
          );
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const resource = yield* GCP.SiteVerification.WebResource("Docs", {
            identifier,
            siteType: "SITE",
            verificationMethod: "FILE",
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* resource.webResourceId;
              const getSite =
                yield* GCP.SiteVerification.GetWebResource(resource);
              return Effect.fn(function* () {
                return yield* getSite({});
              });
            }),
          );
          return { resource, metadata: yield* Probe({}) };
        }),
      );

      expect(out.metadata.id).toEqual(out.resource.webResourceId);
      expect(out.metadata.site?.type).toEqual("SITE");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
