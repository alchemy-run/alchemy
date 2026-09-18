import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { isResourceOfType, Resource } from "../../Resource.ts";
import {
  diffMigrations,
  migrationsAttrs,
  migrationsInputOf,
  stampedOf,
  type MigrationsInput,
} from "../../SQL/Migrations/index.ts";
import {
  withFleet,
  type CurrentFleet,
  type FleetResourceAttributes,
  type FleetResourceProps,
} from "../FleetContext.ts";
import { d1Scope, FleetOperator } from "../OperatorClient.ts";
import type { Providers } from "../Providers.ts";
import {
  catalogOwner,
  ensureCatalog,
  fleetConnection,
  ownsCatalogRecord,
  readCatalog,
  retainCatalog,
  ResourceCatalogError,
} from "../ResourceCatalog.ts";
import { runD1Migrations } from "./ApplyMigrations.ts";

export interface DatabaseProps extends FleetResourceProps {
  /** Fleet-scoped database identity. Omit to generate a unique physical name. */
  name?: string;
  /** Shared SQL migration directory or schema output; recorded in __alchemy_migrations. */
  migrations?: MigrationsInput;
}

export interface Database extends Resource<
  "Celld.D1.Database",
  DatabaseProps,
  FleetResourceAttributes & {
    /** Stable native database identity used by bindings and operator requests. */
    databaseId: string;
    /** Physical database name in the selected fleet. */
    databaseName: string;
    /** Last requested migration directory. */
    migrationsDir: string | undefined;
    /** Retained Alchemy ledger table name. */
    migrationsTable: string | undefined;
    /** Last successfully applied file hashes for deployment-time drift detection. */
    migrationsHashes: Record<string, string>;
  },
  never,
  Providers | CurrentFleet
> {}

export const isDatabase = (value: unknown): value is Database =>
  isResourceOfType(value, "Celld.D1.Database");

/**
 * A native D1 database in the ambient Celld fleet. Deletion retains both data
 * and ownership. Changing its fleet or physical name creates a new identity.
 * The host bootstraps the native D1 operator before any Application publishes.
 *
 * ### Creating a Database
 * **Example:** Declare a database with deploy-time SQL migrations
 * ```typescript
 * const db = yield* Celld.D1.Database("Db", { migrations: "./migrations" });
 * ```
 *
 * ### Querying a Database
 * **Example:** Bind the native database inside a Worker
 * ```typescript
 * const client = yield* Celld.D1.QueryDatabase(db);
 * const rows = yield* client.prepare("SELECT * FROM users").all();
 * ```
 *
 * @resource
 * @product Celld
 */
export const Database = withFleet(Resource<Database>("Celld.D1.Database"));

const validateName = (name: string) =>
  name.length > 0 && !name.includes("\0")
    ? Effect.void
    : Effect.fail(
        new ResourceCatalogError({
          reason: "configuration",
          message:
            "Celld D1 database identities must be nonempty and cannot contain NUL.",
        }),
      );

export const DatabaseProvider = () =>
  Provider.succeed(Database, {
    stables: ["databaseId", "databaseName", "fleetId", "bucket"],
    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return;
      if (
        news.fleetId !== olds.fleetId ||
        !deepEqual(news.bucket, olds.bucket) ||
        (news.name !== undefined &&
          news.name !== (output?.databaseId ?? olds.name))
      )
        return { action: "replace" } as const;
      if (yield* diffMigrations({ news, output }))
        return { action: "update" } as const;
    }),
    read: Effect.fn(function* ({ fqn, instanceId, olds, output }) {
      const connection = yield* fleetConnection(output ?? olds);
      const databaseId =
        output?.databaseId ??
        olds.name ??
        (yield* createPhysicalName({ id: fqn, instanceId }));
      yield* validateName(databaseId);
      const record = yield* readCatalog(connection, "d1", databaseId);
      if (!record) return undefined;
      const desired = {
        ...record,
        fleetId: connection.fleetId,
        owner: yield* catalogOwner(fqn, instanceId),
      };
      const attrs = {
        ...connection,
        databaseId,
        databaseName: databaseId,
        ...migrationsAttrs({
          input: migrationsInputOf(olds),
          run: undefined,
          output,
        }),
      };
      return ownsCatalogRecord(record, desired) ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ fqn, instanceId, news, output }) {
      const connection = yield* fleetConnection(news);
      const databaseId =
        news.name ??
        output?.databaseId ??
        (yield* createPhysicalName({ id: fqn, instanceId }));
      yield* validateName(databaseId);
      yield* ensureCatalog(connection, {
        version: 1,
        kind: "d1",
        physicalId: databaseId,
        label: databaseId,
        fleetId: connection.fleetId,
        owner: yield* catalogOwner(fqn, instanceId),
        retained: false,
      });
      const operator = yield* FleetOperator;
      yield* operator.executeD1Statements(connection, {
        scope: yield* d1Scope(databaseId),
        name: databaseId,
        statements: [{ sql: "SELECT 1;" }],
      });
      const input = migrationsInputOf(news);
      const run = input
        ? yield* runD1Migrations({
            connection,
            databaseId,
            input,
            stamped: stampedOf(output),
          })
        : undefined;
      return {
        ...connection,
        databaseId,
        databaseName: databaseId,
        ...migrationsAttrs({ input, run, output }),
      };
    }),
    delete: Effect.fn(function* ({ fqn, instanceId, output }) {
      yield* retainCatalog(output, {
        version: 1,
        kind: "d1",
        physicalId: output.databaseId,
        label: output.databaseName,
        fleetId: output.fleetId,
        owner: yield* catalogOwner(fqn, instanceId),
        retained: true,
      });
    }),
  });
