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
  logging.getBillingAccountsLocationsBucketsViews({ name }).pipe(
    Effect.as("found" as const),
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
  "getBillingAccountsLocationsBucketsViews on a missing view fails with NotFound or Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const account = (yield* billingAccountId()) || "000000-000000-000000";
      const error = yield* Effect.flip(
        logging.getBillingAccountsLocationsBucketsViews({
          name: `billingAccounts/${account}/locations/global/buckets/_Default/views/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, replace, and delete a billing bucket view",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const account = yield* billingAccountId();
      if (account.length === 0) {
        const error = yield* Effect.flip(
          logging.createBillingAccountsLocationsBucketsViews({
            parent:
              "billingAccounts/000000-000000-000000/locations/global/buckets/_Default",
            viewId: "alchemy-probe",
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
            description: "view parent",
          });
          const view = yield* GCP.Logging.BillingBucketsView("Gce", {
            billingAccountId: account,
            location: bucket.location,
            bucketId: bucket.bucketId,
            filter: 'resource.type = "gce_instance"',
            description: "compute logs",
          });
          return { bucket, view };
        }),
      );

      expect(created.view.viewId).toEqual(expect.any(String));
      expect(created.view.bucketId).toEqual(created.bucket.bucketId);
      expect(created.view.filter).toEqual('resource.type = "gce_instance"');
      expect(created.view.description).toEqual("compute logs");

      const fetched = yield* logging.getBillingAccountsLocationsBucketsViews({
        name: created.view.name,
      });
      expect(fetched.filter).toEqual('resource.type = "gce_instance"');
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Logging.BillingBucket("AppLogs", {
            billingAccountId: account,
            bucketId: created.bucket.bucketId,
            location: created.bucket.location,
            description: "view parent",
          });
          const view = yield* GCP.Logging.BillingBucketsView("Gce", {
            billingAccountId: account,
            location: bucket.location,
            bucketId: bucket.bucketId,
            viewId: created.view.viewId,
            filter: 'resource.type = "gce_instance" AND severity>=ERROR',
            description: "compute errors",
          });
          return { bucket, view };
        }),
      );

      expect(updated.view.name).toEqual(created.view.name);
      expect(updated.view.filter).toEqual(
        'resource.type = "gce_instance" AND severity>=ERROR',
      );

      const last = created.view.viewId.at(-1) ?? "a";
      const nextViewId = `${created.view.viewId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* GCP.Logging.BillingBucket("AppLogs", {
            billingAccountId: account,
            bucketId: created.bucket.bucketId,
            location: created.bucket.location,
            description: "view parent",
          });
          const view = yield* GCP.Logging.BillingBucketsView("Gce", {
            billingAccountId: account,
            location: bucket.location,
            bucketId: bucket.bucketId,
            viewId: nextViewId,
            filter: 'resource.type = "gce_instance"',
            description: "replaced view",
          });
          return { bucket, view };
        }),
      );

      expect(replaced.view.viewId).not.toEqual(created.view.viewId);

      const previousGone = yield* waitUntilGone(created.view.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.view.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
