import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../physical-name.ts";
import { Account } from "../account.ts";
import { CloudflareApi } from "../api.ts";
import {
  Database,
  type DatabaseAttr,
  type DatabaseProps,
  type D1Jurisdiction,
  type ReadReplicationMode,
} from "./database.ts";

interface D1ResponseObject {
  uuid: string;
  name: string;
  created_at: string;
  version: string;
  num_tables: number;
  file_size: number;
  running_in_region: string;
  read_replication: { mode: ReadReplicationMode };
  jurisdiction: "eu" | "fedramp" | null;
}

export const databaseProvider = () =>
  Database.provider.effect(
    Effect.gen(function* () {
      const api = yield* CloudflareApi;
      const accountId = yield* Account;

      const createDatabaseName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          return name ?? (yield* createPhysicalName({ id }));
        });

      const mapResult = <Props extends DatabaseProps>(
        result: D1ResponseObject,
      ): DatabaseAttr<Props> =>
        ({
          databaseId: result.uuid,
          databaseName: result.name,
          accountId,
          jurisdiction: (result.jurisdiction ?? "default") as D1Jurisdiction,
          primaryLocationHint: undefined,
          readReplication: result.read_replication ?? { mode: "disabled" },
          version: result.version,
          numTables: result.num_tables,
          fileSize: result.file_size,
          runningInRegion: result.running_in_region,
          createdAt: result.created_at,
        }) as DatabaseAttr<Props>;

      const createDatabase = Effect.fn(function* (
        databaseName: string,
        props: DatabaseProps,
      ) {
        const payload: {
          name: string;
          jurisdiction?: "eu" | "fedramp";
          primary_location_hint?: string;
        } = {
          name: databaseName,
          jurisdiction:
            props.jurisdiction !== "default" ? props.jurisdiction : undefined,
          primary_location_hint: props.primaryLocationHint,
        };

        const database = yield* api.d1.database
          .create({
            account_id: accountId,
            name: payload.name,
            primary_location_hint: payload.primary_location_hint,
          })
          .pipe(Effect.map((r) => r as unknown as D1ResponseObject));

        if (props.readReplication?.mode) {
          return yield* updateReadReplication(
            database.uuid,
            props.readReplication.mode,
          );
        }

        return database;
      });

      const updateReadReplication = Effect.fn(function* (
        databaseId: string,
        mode: ReadReplicationMode,
      ) {
        return yield* api.d1.database
          .edit(databaseId, {
            account_id: accountId,
            read_replication: { mode },
          })
          .pipe(Effect.map((r) => r as unknown as D1ResponseObject));
      });

      const getDatabase = Effect.fn(function* (databaseId: string) {
        return yield* api.d1.database
          .get(databaseId, { account_id: accountId })
          .pipe(Effect.map((r) => r as unknown as D1ResponseObject));
      });

      const listDatabases = Effect.fn(function* (name?: string) {
        return yield* api.d1.database
          .list({
            account_id: accountId,
            name,
          })
          .pipe(
            Effect.map(
              (r) => (r.result ?? []) as unknown as D1ResponseObject[],
            ),
          );
      });

      const deleteDatabase = Effect.fn(function* (databaseId: string) {
        yield* api.d1.database
          .delete(databaseId, { account_id: accountId })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      });

      return {
        stables: ["databaseId", "accountId"],

        diff: Effect.fn(function* ({ id, news, output }) {
          if (output.accountId !== accountId) {
            return { action: "replace" } as const;
          }

          const databaseName = yield* createDatabaseName(id, news.name);
          if (databaseName !== output.databaseName) {
            return { action: "replace" } as const;
          }

          if (
            news.primaryLocationHint !== undefined &&
            news.primaryLocationHint !== output.primaryLocationHint
          ) {
            return { action: "replace" } as const;
          }

          const newJurisdiction = news.jurisdiction ?? "default";
          if (newJurisdiction !== output.jurisdiction) {
            return { action: "replace" } as const;
          }
        }),

        create: Effect.fn(function* ({ id, news, session }) {
          const databaseName = yield* createDatabaseName(id, news.name);

          const existingDatabases = yield* listDatabases(databaseName);
          const existing = existingDatabases.find(
            (db) => db.name === databaseName,
          );

          if (existing) {
            if (news.adopt) {
              yield* session.note(`Adopting existing database: ${databaseName}`);
              if (news.readReplication?.mode) {
                const updated = yield* updateReadReplication(
                  existing.uuid,
                  news.readReplication.mode,
                );
                return mapResult<DatabaseProps>(updated);
              }
              return mapResult<DatabaseProps>(existing);
            }
            return yield* Effect.fail(
              new Error(`Database "${databaseName}" already exists`),
            );
          }

          yield* session.note(`Creating database: ${databaseName}`);
          const database = yield* createDatabase(databaseName, news);
          yield* session.note(database.uuid);

          return mapResult<DatabaseProps>(database);
        }),

        update: Effect.fn(function* ({ news, output, session }) {
          const currentMode = output.readReplication?.mode ?? "disabled";
          const newMode = news.readReplication?.mode ?? "disabled";

          if (currentMode !== newMode) {
            yield* session.note(`Updating read replication: ${newMode}`);
            const updated = yield* updateReadReplication(
              output.databaseId,
              newMode,
            );
            return mapResult<DatabaseProps>(updated);
          }

          return output;
        }),

        delete: Effect.fn(function* ({ output, olds }) {
          if (olds.delete !== false) {
            yield* deleteDatabase(output.databaseId);
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          if (output?.databaseId) {
            return yield* getDatabase(output.databaseId).pipe(
              Effect.map(mapResult<DatabaseProps>),
              Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
            );
          }

          const databaseName = yield* createDatabaseName(id, olds?.name);
          const databases = yield* listDatabases(databaseName);
          const match = databases.find((db) => db.name === databaseName);

          if (match) {
            return mapResult<DatabaseProps>(match);
          }

          return undefined;
        }),
      };
    }),
  );
