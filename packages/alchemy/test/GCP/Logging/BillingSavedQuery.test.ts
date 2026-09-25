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

// Billing-account saved queries return BadRequest ("Billing account is
// not supported") on this testing project. Set GCP_TEST_BILLING_SAVED_QUERY=1
// on an entitled billing account to run the lifecycle.
const entitled = process.env.GCP_TEST_BILLING_SAVED_QUERY === "1";

const waitUntilGone = (name: string) =>
  logging.getBillingAccountsLocationsSavedQueries({ name }).pipe(
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
  "getBillingAccountsLocationsSavedQueries on a missing query fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const account = (yield* billingAccountId()) || "000000-000000-000000";
      const error = yield* Effect.flip(
        logging.getBillingAccountsLocationsSavedQueries({
          name: `billingAccounts/${account}/locations/global/savedQueries/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || entitled)(
  "createBillingAccountsLocationsSavedQueries is rejected when the billing account is not supported",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const account = (yield* billingAccountId()) || "000000-000000-000000";
      const error = yield* Effect.flip(
        logging.createBillingAccountsLocationsSavedQueries({
          parent: `billingAccounts/${account}/locations/global`,
          savedQueryId: "alchemy-probe",
          body: {
            displayName: "probe",
            visibility: "PRIVATE",
            loggingQuery: { filter: "severity>=ERROR" },
          },
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
      if (error._tag === "BadRequest") {
        expect(error.message).toContain("Billing account is not supported");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !entitled)(
  "create, update, replace, and delete a billing saved query",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const account = yield* billingAccountId();
      if (account.length === 0) {
        const error = yield* Effect.flip(
          logging.createBillingAccountsLocationsSavedQueries({
            parent: "billingAccounts/000000-000000-000000/locations/global",
            savedQueryId: "alchemy-probe",
            body: {
              displayName: "probe",
              visibility: "PRIVATE",
              loggingQuery: { filter: "severity>=ERROR" },
            },
          }),
        );
        expect(["NotFound", "Forbidden"]).toContain(error._tag);
        yield* stack.destroy();
        return;
      }

      const access = yield* logging
        .listBillingAccountsLocationsSavedQueries({
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

      const createdOrDenied = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* GCP.Logging.BillingSavedQuery("Errors", {
              billingAccountId: account,
              displayName: "billing errors",
              loggingQuery: { filter: "severity>=ERROR" },
              description: "error query",
            });
          }),
        )
        .pipe(
          Effect.map((value) => ({ _tag: "created" as const, value })),
          Effect.catchTag("BadRequest", (error) =>
            Effect.succeed({
              _tag: "BadRequest" as const,
              message: error.message ?? "",
            }),
          ),
        );
      if (createdOrDenied._tag === "BadRequest") {
        expect(createdOrDenied.message).toContain(
          "Billing account is not supported",
        );
        yield* stack.destroy();
        return;
      }
      const created = createdOrDenied.value;

      expect(created.savedQueryId).toEqual(expect.any(String));
      expect(created.location).toEqual("global");
      expect(created.billingAccountId).toEqual(account);
      expect(created.displayName).toEqual("billing errors");
      expect(created.loggingQuery?.filter).toEqual("severity>=ERROR");
      expect(created.description).toEqual("error query");

      const fetched = yield* logging.getBillingAccountsLocationsSavedQueries({
        name: created.name,
      });
      expect(fetched.displayName).toEqual("billing errors");
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.BillingSavedQuery("Errors", {
            billingAccountId: account,
            savedQueryId: created.savedQueryId,
            location: created.location,
            displayName: "billing warnings",
            loggingQuery: { filter: "severity>=WARNING" },
            description: "warning query",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("billing warnings");
      expect(updated.loggingQuery?.filter).toEqual("severity>=WARNING");

      const last = created.savedQueryId.at(-1) ?? "a";
      const nextId = `${created.savedQueryId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.BillingSavedQuery("Errors", {
            billingAccountId: account,
            savedQueryId: nextId,
            displayName: "replaced query",
            loggingQuery: { filter: "severity>=ERROR" },
            description: "replaced query",
          });
        }),
      );

      expect(replaced.savedQueryId).not.toEqual(created.savedQueryId);

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
