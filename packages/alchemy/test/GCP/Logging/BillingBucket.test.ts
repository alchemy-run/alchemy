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
  logging.getBillingAccountsLocationsBuckets({ name }).pipe(
    Effect.map((bucket) =>
      bucket.lifecycleState === "DELETE_REQUESTED"
        ? ("gone" as const)
        : ("found" as const),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
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
  "getBillingAccountsLocationsBuckets on a missing bucket fails with NotFound or Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const account = (yield* billingAccountId()) || "000000-000000-000000";
      const error = yield* Effect.flip(
        logging.getBillingAccountsLocationsBuckets({
          name: `billingAccounts/${account}/locations/global/buckets/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, replace, and delete a billing log bucket",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const account = yield* billingAccountId();
      if (account.length === 0) {
        const error = yield* Effect.flip(
          logging.createBillingAccountsLocationsBuckets({
            parent: "billingAccounts/000000-000000-000000/locations/global",
            bucketId: "alchemy-probe",
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
          return yield* GCP.Logging.BillingBucket("AppLogs", {
            billingAccountId: account,
            description: "application logs",
            retentionDays: 31,
          });
        }),
      );

      expect(created.bucketId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.billingAccountId).toEqual(account);
      expect(created.name).toEqual(
        `billingAccounts/${account}/locations/global/buckets/${created.bucketId}`,
      );
      expect(created.description).toEqual("application logs");
      expect(created.retentionDays).toEqual(31);

      const fetched = yield* logging.getBillingAccountsLocationsBuckets({
        name: created.name,
      });
      expect(fetched.retentionDays).toEqual(31);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.BillingBucket("AppLogs", {
            billingAccountId: account,
            bucketId: created.bucketId,
            location: created.location,
            description: "retained application logs",
            retentionDays: 60,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.retentionDays).toEqual(60);

      const last = created.bucketId.at(-1) ?? "a";
      const nextBucketId = `${created.bucketId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.BillingBucket("AppLogs", {
            billingAccountId: account,
            bucketId: nextBucketId,
            location: "global",
            description: "replaced bucket",
            retentionDays: 31,
          });
        }),
      );

      expect(replaced.bucketId).not.toEqual(created.bucketId);

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
