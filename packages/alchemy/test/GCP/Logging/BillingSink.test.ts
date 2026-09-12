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
  logging.getBillingAccountsSinks({ sinkName: name }).pipe(
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
  "getBillingAccountsSinks on a missing sink fails with NotFound or Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const account = (yield* billingAccountId()) || "000000-000000-000000";
      const error = yield* Effect.flip(
        logging.getBillingAccountsSinks({
          sinkName: `billingAccounts/${account}/sinks/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, replace, and delete a billing sink",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const account = yield* billingAccountId();
      if (account.length === 0) {
        const error = yield* Effect.flip(
          logging.createBillingAccountsSinks({
            parent: "billingAccounts/000000-000000-000000",
            body: {
              name: "alchemy-probe",
              destination:
                "logging.googleapis.com/billingAccounts/000000-000000-000000/locations/global/buckets/_Default",
            },
          }),
        );
        expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
        yield* stack.destroy();
        return;
      }

      const access = yield* logging
        .listBillingAccountsSinks({
          parent: `billingAccounts/${account}`,
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

      const destination = `logging.googleapis.com/billingAccounts/${account}/locations/global/buckets/_Default`;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.BillingSink("Errors", {
            billingAccountId: account,
            destination,
            filter: "severity>=ERROR",
            description: "application errors",
          });
        }),
      );

      expect(created.sinkId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `billingAccounts/${account}/sinks/${created.sinkId}`,
      );
      expect(created.destination).toEqual(destination);
      expect(created.filter).toEqual("severity>=ERROR");
      expect(created.description).toEqual("application errors");

      const fetched = yield* logging.getBillingAccountsSinks({
        sinkName: created.name,
      });
      expect(fetched.destination).toEqual(destination);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.BillingSink("Errors", {
            billingAccountId: account,
            sinkId: created.sinkId,
            destination,
            filter: "severity>=WARNING",
            description: "warnings and errors",
            disabled: true,
          });
        }),
      );

      expect(updated.filter).toEqual("severity>=WARNING");
      expect(updated.disabled).toEqual(true);

      const last = created.sinkId.at(-1) ?? "a";
      const nextSinkId = `${created.sinkId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.BillingSink("Errors", {
            billingAccountId: account,
            sinkId: nextSinkId,
            destination,
            filter: "severity>=WARNING",
            description: "replaced sink",
          });
        }),
      );

      expect(replaced.sinkId).not.toEqual(created.sinkId);

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
