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
  logging.getBillingAccountsExclusions({ name }).pipe(
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
  "getBillingAccountsExclusions on a missing exclusion fails with NotFound or Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const account = (yield* billingAccountId()) || "000000-000000-000000";
      const error = yield* Effect.flip(
        logging.getBillingAccountsExclusions({
          name: `billingAccounts/${account}/exclusions/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, replace, and delete a billing exclusion",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const account = yield* billingAccountId();
      if (account.length === 0) {
        const error = yield* Effect.flip(
          logging.createBillingAccountsExclusions({
            parent: "billingAccounts/000000-000000-000000",
            body: { name: "alchemy-probe", filter: "severity=DEBUG" },
          }),
        );
        expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
        yield* stack.destroy();
        return;
      }

      const access = yield* logging
        .listBillingAccountsExclusions({
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

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.BillingExclusion("DropDebug", {
            billingAccountId: account,
            filter: "severity=DEBUG",
            description: "drop debug entries",
          });
        }),
      );

      expect(created.exclusionId).toEqual(expect.any(String));
      expect(created.billingAccountId).toEqual(account);
      expect(created.name).toEqual(
        `billingAccounts/${account}/exclusions/${created.exclusionId}`,
      );
      expect(created.filter).toEqual("severity=DEBUG");
      expect(created.description).toEqual("drop debug entries");
      expect(created.disabled).toEqual(false);

      const fetched = yield* logging.getBillingAccountsExclusions({
        name: created.name,
      });
      expect(fetched.filter).toEqual("severity=DEBUG");
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("drop debug entries");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.BillingExclusion("DropDebug", {
            billingAccountId: account,
            exclusionId: created.exclusionId,
            filter: "severity<ERROR",
            description: "drop non-errors",
            disabled: true,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.filter).toEqual("severity<ERROR");
      expect(updated.description).toEqual("drop non-errors");
      expect(updated.disabled).toEqual(true);

      const last = created.exclusionId.at(-1) ?? "a";
      const nextExclusionId = `${created.exclusionId.slice(0, -1)}${last === "z" ? "0" : "z"}`;

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Logging.BillingExclusion("DropDebug", {
            billingAccountId: account,
            exclusionId: nextExclusionId,
            filter: "severity=DEBUG",
            description: "replaced exclusion",
          });
        }),
      );

      expect(replaced.exclusionId).not.toEqual(created.exclusionId);
      expect(replaced.description).toEqual("replaced exclusion");

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
