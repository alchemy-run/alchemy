import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudbilling from "@distilled.cloud/gcp/cloudbilling_v1";
import * as logging from "@distilled.cloud/gcp/logging_v2";
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
  logging.getBillingAccountsLocationsBucketsLinks({ name }).pipe(
    Effect.map((link) =>
      link.lifecycleState === "DELETE_REQUESTED"
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const billingAccountId = () =>
  cloudbilling.getBillingInfoProjects({ name: `projects/${project}` }).pipe(
    Effect.map(
      (info) => (info.billingAccountName ?? "").split("/").pop() ?? "",
    ),
    Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed("")),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getBillingAccountsLocationsBucketsLinks on a missing link fails with NotFound or Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const account = (yield* billingAccountId()) || "000000-000000-000000";
      const error = yield* Effect.flip(
        logging.getBillingAccountsLocationsBucketsLinks({
          name: `billingAccounts/${account}/locations/global/buckets/_Default/links/alchemy_missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, replace, and delete a billing bucket link",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const account = yield* billingAccountId();
      if (account.length === 0) {
        const error = yield* Effect.flip(
          logging.createBillingAccountsLocationsBucketsLinks({
            parent:
              "billingAccounts/000000-000000-000000/locations/global/buckets/_Default",
            linkId: "alchemy_probe",
            body: { description: "probe" },
          }),
        );
        expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
        yield* stack.destroy();
        return;
      }

      const access = yield* logging
        .listBillingAccountsLocationsBuckets({
          parent: `billingAccounts/${account}/locations/-`,
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
          const bucket = yield* GCP.Logging.BillingBucket("AppLogs", {
            billingAccountId: account,
            analyticsEnabled: true,
            description: "analytics parent",
          });
          const link = yield* GCP.Logging.BillingBucketsLink("Analytics", {
            billingAccountId: account,
            location: bucket.location,
            bucketId: bucket.bucketId,
            description: "log analytics",
          });
          return { bucket, link };
        }),
      );

      expect(created.link.linkId).toEqual(expect.any(String));
      expect(created.link.bucketId).toEqual(created.bucket.bucketId);
      expect(created.link.description).toEqual("log analytics");

      const fetched = yield* logging.getBillingAccountsLocationsBucketsLinks({
        name: created.link.name,
      });
      expect(fetched.description).toContain("alchemy-id=");

      const nextLinkId = `${created.link.linkId.replace(/[^a-z0-9_]/g, "_")}_z`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Logging.BillingBucket("AppLogs", {
            billingAccountId: account,
            bucketId: created.bucket.bucketId,
            location: created.bucket.location,
            analyticsEnabled: true,
            description: "analytics parent",
          });
          const link = yield* GCP.Logging.BillingBucketsLink("Analytics", {
            billingAccountId: account,
            location: bucket.location,
            bucketId: bucket.bucketId,
            linkId: nextLinkId,
            description: "replaced link",
          });
          return { bucket, link };
        }),
      );

      expect(replaced.link.linkId).not.toEqual(created.link.linkId);

      const previousGone = yield* waitUntilGone(created.link.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.link.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
