import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as siteVerification from "@distilled.cloud/gcp/siteVerification_v1";
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

const ENTITLEMENT_TAGS = [
  "Forbidden",
  "NotFound",
  "Unauthorized",
  "BadRequest",
] as const;

const waitUntilGone = (webResourceId: string) =>
  siteVerification
    .getWebResource({
      id: decodeURIComponent(webResourceId),
    })
    .pipe(
      Effect.as("found" as const),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
      Effect.catchTag("Unauthorized", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );

const probeAccess = () =>
  siteVerification.listWebResource({}).pipe(
    Effect.as("ok" as const),
    Effect.catchTag(["Forbidden", "NotFound", "Unauthorized"], (error) =>
      Effect.succeed(error._tag),
    ),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getWebResource on a missing site fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        siteVerification.getWebResource({
          id: "http://alchemy-missing.example.com/",
        }),
      );
      expect(["NotFound", "Forbidden", "Unauthorized", "BadRequest"]).toContain(
        error._tag,
      );
      if (error._tag === "Forbidden") {
        expect(error.message).toContain("insufficient authentication scopes");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "getTokenWebResource returns a token or a typed entitlement tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* siteVerification
        .getTokenWebResource({
          body: {
            site: {
              identifier: "https://alchemy-site-verification.test/",
              type: "SITE",
            },
            verificationMethod: "FILE",
          },
        })
        .pipe(
          Effect.map((token) => ({
            _tag: "ok" as const,
            token: token.token,
            method: token.method,
          })),
          Effect.catchTag(
            ["Forbidden", "NotFound", "Unauthorized", "BadRequest"],
            (error) =>
              Effect.succeed({
                _tag: error._tag,
                token: undefined,
                method: undefined,
              }),
          ),
        );

      if (result._tag === "ok") {
        expect(result.token?.length).toBeGreaterThan(0);
        expect(result.method).toEqual("FILE");
      } else {
        expect([...ENTITLEMENT_TAGS]).toContain(result._tag);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "insertWebResource without a placed token fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* siteVerification
        .insertWebResource({
          verificationMethod: "FILE",
          body: {
            site: {
              identifier: "https://alchemy-site-verification.test/",
              type: "SITE",
            },
          },
        })
        .pipe(
          Effect.map((resource) => ({
            _tag: "ok" as const,
            id: resource.id,
          })),
          Effect.catchTag(
            ["Forbidden", "NotFound", "Unauthorized", "BadRequest", "Conflict"],
            (error) => Effect.succeed({ _tag: error._tag, id: undefined }),
          ),
        );

      if (result._tag === "ok") {
        if (result.id) {
          yield* siteVerification
            .deleteWebResource({
              id: decodeURIComponent(result.id),
            })
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
      } else {
        expect([
          "Forbidden",
          "NotFound",
          "Unauthorized",
          "BadRequest",
          "Conflict",
        ]).toContain(result._tag);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete a web resource",
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

      const resource = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SiteVerification.WebResource("Docs", {
            identifier,
            siteType: "SITE",
            verificationMethod: "FILE",
          });
        }),
      );
      expect(resource.webResourceId.length).toBeGreaterThan(0);
      expect(resource.identifier).toContain("alchemy-site-verification.test");
      expect(resource.siteType).toEqual("SITE");

      const fetched = yield* siteVerification.getWebResource({
        id: decodeURIComponent(resource.webResourceId),
      });
      expect(fetched.id).toEqual(resource.webResourceId);
      expect(fetched.site?.type).toEqual("SITE");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.SiteVerification.WebResource("Docs", {
            identifier: resource.identifier,
            siteType: "SITE",
            owners: resource.owners,
          });
        }),
      );

      expect(updated.webResourceId).toEqual(resource.webResourceId);
      expect(updated.owners).toEqual(resource.owners);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(resource.webResourceId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
