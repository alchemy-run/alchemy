import * as Azure from "@/Azure";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { randomUUID } from "node:crypto";

/** Shared scaffolding for the Azure SQL child/setting tests. */

export const SQL_TAGS = ["provider:azure", "provider:azure:sql", "live"];

// The free trial refuses new SQL servers in eastus (`ProvisioningDisabled`).
export const SQL_LOCATION = "centralus";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const newPassword = Effect.sync(() =>
  Redacted.make(`Az!${randomUUID()}`),
);

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** A resource group and a SQL server with a SQL administrator. */
export const sqlServer = (
  password: Redacted.Redacted<string>,
  props: Partial<Azure.Sql.ServerProps> = {},
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: SQL_LOCATION,
    });
    const server = yield* Azure.Sql.Server("Db", {
      resourceGroup: group.resourceGroupName,
      location: group.location,
      administratorLogin: "alchemyadmin",
      administratorLoginPassword: password,
      ...props,
    });
    return { group, server };
  });

/** A resource group, a SQL server, and a Basic database. */
export const sqlDatabase = (
  password: Redacted.Redacted<string>,
  props: Partial<Azure.Sql.DatabaseProps> = {},
  serverProps: Partial<Azure.Sql.ServerProps> = {},
) =>
  Effect.gen(function* () {
    const { group, server } = yield* sqlServer(password, serverProps);
    const database = yield* Azure.Sql.Database("App", {
      resourceGroup: group.resourceGroupName,
      server: server.serverName,
      sku: { name: "Basic" },
      requestedBackupStorageRedundancy: "Local",
      ...props,
    });
    return { group, server, database };
  });

/**
 * Poll an out-of-band GET until it reports a not-found error. Returns
 * `"gone"` or `"found"` (when the budget runs out).
 */
export const awaitGone = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A, E, R>,
  times = 30,
) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchIf(
      (e) =>
        e._tag === "ResourceNotFound" ||
        e._tag === "ResourceGroupNotFound" ||
        e._tag === "NotFound",
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times,
    }),
  );

/** Poll an out-of-band GET until `until` holds (bounded). */
export const awaitObserved = <A, E, R>(
  get: Effect.Effect<A, E, R>,
  until: (value: A) => boolean,
  times = 30,
) =>
  get.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until,
      times,
    }),
  );
