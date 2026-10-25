import { randomUUID } from "node:crypto";
import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

// Resources the fixture binds. Module-scope so the test stack yields the
// same declarations.

// The free trial refuses new SQL servers in eastus/eastus2/westus2
// (`ProvisioningDisabled`); centralus and westus3 accept them.
const PRIMARY_LOCATION = "centralus";
const SECONDARY_LOCATION = "westus3";

export const ADMIN_LOGIN = "alchemyadmin";

/**
 * SQL administrator password of the servers, new on every test run. The
 * export route takes it from the test.
 */
export const ADMIN_PASSWORD = `Az!${randomUUID()}`;

const server = (id: string, location: string) =>
  Azure.Sql.Server(id, {
    location,
    administratorLogin: ADMIN_LOGIN,
    administratorLoginPassword: Redacted.make(ADMIN_PASSWORD),
  });

export const Primary = server("SqlBindingsPrimary", PRIMARY_LOCATION);
export const Secondary = server("SqlBindingsSecondary", SECONDARY_LOCATION);

/** The SQL import/export service reaches the server as an Azure service. */
export const AllowAzure = Effect.gen(function* () {
  const primary = yield* Primary;
  return yield* Azure.Sql.FirewallRule("SqlBindingsAllowAzure", {
    server: primary.serverName,
    name: "AllowAllWindowsAzureIps",
    startIpAddress: "0.0.0.0",
    endIpAddress: "0.0.0.0",
  });
});

const database = (id: string, props: Partial<Azure.Sql.DatabaseProps> = {}) =>
  Effect.gen(function* () {
    const primary = yield* Primary;
    return yield* Azure.Sql.Database(id, {
      server: primary.serverName,
      location: PRIMARY_LOCATION,
      sku: { name: "Basic" },
      requestedBackupStorageRedundancy: "Local",
      ...props,
    });
  });

/** Exported, failed over, and probed by the pause/resume/restore-point bindings. */
export const App = database("SqlBindingsApp");

/** A Basic elastic pool with one database (~$0.10/hour). */
export const Pool = Effect.gen(function* () {
  const primary = yield* Primary;
  return yield* Azure.Sql.ElasticPool("SqlBindingsPool", {
    server: primary.serverName,
    location: PRIMARY_LOCATION,
    sku: { name: "BasicPool", tier: "Basic", capacity: 50 },
    perDatabaseSettings: { minCapacity: 0, maxCapacity: 5 },
  });
});

export const Pooled = Effect.gen(function* () {
  const pool = yield* Pool;
  return yield* database("SqlBindingsPooled", {
    sku: undefined,
    elasticPoolId: pool.elasticPoolId,
  });
});

/** A failover group of the primary server with its geo-secondary in westus3. */
export const Group = Effect.gen(function* () {
  const primary = yield* Primary;
  const secondary = yield* Secondary;
  const replicated = yield* database("SqlBindingsReplicated");
  return yield* Azure.Sql.FailoverGroup("SqlBindingsGroup", {
    server: primary.serverName,
    partnerServers: [secondary.serverId],
    databases: [replicated.databaseId],
  });
});

/** Export target: a container on a new storage account. */
export const Backups = Azure.Storage.StorageAccount("SqlBindingsBackups");
export const Bacpacs = Effect.gen(function* () {
  const account = yield* Backups;
  return yield* Azure.Storage.BlobContainer("SqlBindingsBacpacs", {
    storageAccount: account.storageAccountName,
  });
});

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result: result ?? null })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * Answer the operation's error tag as a result, so a caller can assert
 * Azure's typed rejection. `AuthorizationFailed` stays an error: the role
 * is still propagating and the caller retries.
 */
const rejection = <E extends { readonly _tag: string; readonly message?: string }>(
  effect: Effect.Effect<unknown, E, RuntimeContext>,
) =>
  respond(
    effect.pipe(
      Effect.flatMap(() => Effect.succeed({ rejected: false })),
      Effect.catchIf(
        (e) => e._tag !== "AuthorizationFailed",
        (e) => Effect.succeed({ rejected: e._tag, message: e.message }),
      ),
    ),
  );

/**
 * Effect-native Azure Function exercising every Azure SQL runtime-action
 * binding on a managed-identity host, one route per binding.
 */
export default class SqlFunction extends Azure.Functions.Function<SqlFunction>()(
  "SqlFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const app = yield* App;
    const pool = yield* Pool;
    const group = yield* Group;
    const secondary = yield* Secondary;

    const pauseDatabase = yield* Azure.Sql.PauseDatabase(app);
    const resumeDatabase = yield* Azure.Sql.ResumeDatabase(app);
    const createRestorePoint = yield* Azure.Sql.CreateRestorePoint(app);
    const failoverDatabase = yield* Azure.Sql.FailoverDatabase(app);
    const exportDatabase = yield* Azure.Sql.ExportDatabase(app);
    const failoverElasticPool = yield* Azure.Sql.FailoverElasticPool(pool);
    const failoverFailoverGroup = yield* Azure.Sql.FailoverFailoverGroup(group, secondary);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const param = (name: string) => url.searchParams.get(name) ?? "";
        switch (url.pathname) {
          case "/pause-database":
            return yield* rejection(pauseDatabase());
          case "/resume-database":
            return yield* rejection(resumeDatabase());
          case "/create-restore-point":
            return yield* rejection(createRestorePoint({ restorePointLabel: "binding-test" }));
          case "/failover-database":
            return yield* rejection(failoverDatabase());
          case "/export-database":
            return yield* respond(
              Effect.as(
                exportDatabase({
                  storageUri: param("uri"),
                  storageKeyType: "StorageAccessKey",
                  storageKey: param("key"),
                  administratorLogin: ADMIN_LOGIN,
                  administratorLoginPassword: Redacted.make(param("password")),
                }),
                { accepted: true },
              ),
            );
          case "/failover-elastic-pool":
            return yield* rejection(failoverElasticPool());
          case "/failover-failover-group":
            return yield* respond(Effect.as(failoverFailoverGroup(), { failedOver: true }));
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.Sql.PauseDatabaseHttp,
        Azure.Sql.ResumeDatabaseHttp,
        Azure.Sql.CreateRestorePointHttp,
        Azure.Sql.FailoverDatabaseHttp,
        Azure.Sql.ExportDatabaseHttp,
        Azure.Sql.FailoverElasticPoolHttp,
        Azure.Sql.FailoverFailoverGroupHttp,
      ),
    ),
  ),
) {}
