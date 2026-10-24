import * as Azure from "@alchemy.run/azure";
import { type AzureOpError, Credentials } from "@distilled.cloud/azure";
import * as acat from "@distilled.cloud/azure/appcomplianceautomation";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:appcomplianceautomation", "live"];

/** The `x-ms-aad-user-token` header every App Compliance Automation call needs. */
export const userToken = Effect.gen(function* () {
  const credentials = yield* yield* Credentials;
  return yield* Effect.sync(() =>
    Redacted.make(`Bearer ${Redacted.value(credentials.bearerToken)}`),
  );
});

/** Repeat a GET until it reports a typed not-found; `"gone"` or `"found"`. */
export const gone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

export const getReport = (reportName: string) =>
  Effect.flatMap(userToken, (token) => acat.GetReport({ reportName, userToken: token }));

/** Storage account + report shared by the report child-resource tests. */
export const reportProgram = Effect.gen(function* () {
  const account = yield* Azure.Storage.StorageAccount("Evidence");
  const report = yield* Azure.AppComplianceAutomation.Report("Report", {
    resources: [
      {
        resourceId: account.storageAccountId,
        resourceType: "Microsoft.Storage/storageAccounts",
      },
    ],
  });
  return { account, report };
});
