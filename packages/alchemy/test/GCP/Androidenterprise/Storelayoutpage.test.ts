import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as androidenterprise from "@distilled.cloud/gcp/androidenterprise_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  enterpriseId,
  hasGcpCreds,
  logLevel,
  probeEnterpriseId,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (accountId: string, pageId: string) =>
  androidenterprise
    .getStorelayoutpages({ enterpriseId: accountId, pageId })
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
  "getStorelayoutpages on a missing page fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androidenterprise.getStorelayoutpages({
          enterpriseId: probeEnterpriseId,
          pageId: "alchemy-missing-page",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_ANDROIDENTERPRISE)(
  "insertStorelayoutpages without EMM access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        androidenterprise.insertStorelayoutpages({
          enterpriseId: probeEnterpriseId,
          body: {
            name: [{ locale: "en-US", text: "Alchemy Probe Page" }],
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a store layout page",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Androidenterprise.Storelayoutpage("Home", {
            enterpriseId: enterpriseId!,
            name: [{ locale: "en-US", text: "Home" }],
          });
        }),
      );

      expect(created.pageId.length).toBeGreaterThan(0);
      expect(created.enterpriseId).toEqual(enterpriseId);
      expect(created.name?.[0]?.text).toEqual("Home");

      const fetched = yield* androidenterprise.getStorelayoutpages({
        enterpriseId: created.enterpriseId,
        pageId: created.pageId,
      });
      expect(fetched.id).toEqual(created.pageId);
      expect(fetched.name?.[0]?.text).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Androidenterprise.Storelayoutpage("Home", {
            enterpriseId: created.enterpriseId,
            pageId: created.pageId,
            name: [{ locale: "en-US", text: "Featured" }],
          });
        }),
      );

      expect(updated.pageId).toEqual(created.pageId);
      expect(updated.name?.[0]?.text).toEqual("Featured");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.enterpriseId, created.pageId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
