import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as adsenseplatform from "@distilled.cloud/gcp/adsenseplatform_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  hasGcpCreds,
  logLevel,
  probeDomain,
  probeName,
  probeParent,
  resolveParent,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getPlatformsAccountsSites on a missing site fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        adsenseplatform.getPlatformsAccountsSites({ name: probeName }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "createPlatformsAccountsSites without AdSense for Platforms access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        adsenseplatform.createPlatformsAccountsSites({
          parent: probeParent,
          body: { domain: probeDomain },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, replace, and delete a platform site",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const parent = yield* resolveParent();
      const probe = yield* adsenseplatform
        .listPlatformsAccountsSites({
          parent: parent ?? probeParent,
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
      if (probe.tag !== "ok" || parent === undefined) {
        if (probe.tag !== "ok") {
          expect(["Forbidden", "NotFound"]).toContain(probe.tag);
        }
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Adsenseplatform.PlatformsSite("Blog", {
            parent,
            domain: "example.com",
          });
        }),
      );

      expect(created.name).toContain("/sites/");
      expect(created.parent).toEqual(parent);
      expect(created.siteId.length).toBeGreaterThan(0);
      expect(created.domain).toEqual("example.com");

      const fetched = yield* adsenseplatform.getPlatformsAccountsSites({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.domain).toContain("alch.");
      expect(fetched.domain).toContain("example.com");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Adsenseplatform.PlatformsSite("Blog", {
            parent: created.parent,
            domain: "blog.example.com",
          });
        }),
      );

      expect(updated.parent).toEqual(created.parent);
      expect(updated.domain).toEqual("blog.example.com");

      const fetchedUpdate = yield* adsenseplatform.getPlatformsAccountsSites({
        name: updated.name,
      });
      expect(fetchedUpdate.domain).toContain("blog.example.com");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(updated.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
