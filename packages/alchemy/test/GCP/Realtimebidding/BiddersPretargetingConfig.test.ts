import * as GCP from "@/GCP";
import {
  parentsFromEnv,
  PROBE_NAME,
  PROBE_PARENT,
} from "@/GCP/Realtimebidding/internal.ts";
import * as Test from "@/Test/Alchemy";
import * as rtb from "@distilled.cloud/gcp/realtimebidding_v1";
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

const waitUntilGone = (name: string) =>
  rtb.getBiddersPretargetingConfigs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const probeCreate = (parent: string) =>
  rtb.createBiddersPretargetingConfigs({
    parent,
    body: { displayName: "alchemy-rtb-probe" },
  });

const resolveParent = () =>
  Effect.gen(function* () {
    const envParent = parentsFromEnv()[0];
    if (envParent) return envParent;
    const listed = yield* rtb.listBidders({ pageSize: 10 }).pipe(
      Effect.map((page) => page.bidders?.find((bidder) => bidder.name)?.name),
      Effect.catchTag(["NotFound", "Forbidden"] as const, () =>
        Effect.succeed(undefined),
      ),
    );
    return listed;
  });

test.provider.skipIf(!hasGcpCreds)(
  "getBiddersPretargetingConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        rtb.getBiddersPretargetingConfigs({ name: PROBE_NAME }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "createBiddersPretargetingConfigs without Real-time Bidding access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* probeCreate(PROBE_PARENT).pipe(
        Effect.map((row) => ({ _tag: "ok" as const, name: row.name })),
        Effect.catchTag(["Forbidden", "NotFound", "BadRequest"], (error) =>
          Effect.succeed({
            _tag: error._tag,
            name: undefined as string | undefined,
          }),
        ),
      );

      if (result._tag === "ok") {
        if (result.name) {
          yield* rtb
            .deleteBiddersPretargetingConfigs({ name: result.name })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }
      } else {
        expect(["Forbidden", "NotFound", "BadRequest"]).toContain(result._tag);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete a pretargeting config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const parent = yield* resolveParent();
      if (!parent) {
        const error = yield* Effect.flip(probeCreate(PROBE_PARENT));
        expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);
        yield* stack.destroy();
        return;
      }

      const access = yield* rtb
        .listBiddersPretargetingConfigs({
          parent,
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
          return yield* GCP.Realtimebidding.BiddersPretargetingConfig(
            "WebHtml",
            {
              parent,
              displayName: "web-html",
              includedEnvironments: ["WEB"],
              includedFormats: ["HTML"],
            },
          );
        }),
      );

      expect(created.name).toContain("/pretargetingConfigs/");
      expect(created.parent).toEqual(parent);
      expect(created.configId.length).toBeGreaterThan(0);
      expect(created.displayName).toEqual("web-html");
      expect(created.includedEnvironments).toContain("WEB");
      expect(created.includedFormats).toContain("HTML");
      expect(["ACTIVE", "SUSPENDED"]).toContain(created.state);

      const fetched = yield* rtb.getBiddersPretargetingConfigs({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("[alchemy ");
      expect(fetched.displayName).toContain("web-html");
      expect(fetched.includedFormats).toContain("HTML");

      const listed = yield* rtb.listBiddersPretargetingConfigs({
        parent,
        pageSize: 100,
      });
      expect(
        (listed.pretargetingConfigs ?? []).some(
          (row) => row.name === created.name,
        ),
      ).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Realtimebidding.BiddersPretargetingConfig(
            "WebHtml",
            {
              parent: created.parent,
              configId: created.configId,
              displayName: "web-html-v2",
              includedEnvironments: ["WEB"],
              includedFormats: ["HTML", "NATIVE"],
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("web-html-v2");
      expect(updated.includedFormats).toContain("NATIVE");

      const fetchedUpdate = yield* rtb.getBiddersPretargetingConfigs({
        name: updated.name,
      });
      expect(fetchedUpdate.displayName).toContain("web-html-v2");
      expect(fetchedUpdate.displayName).toContain("[alchemy ");
      expect(fetchedUpdate.includedFormats).toContain("NATIVE");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(updated.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
