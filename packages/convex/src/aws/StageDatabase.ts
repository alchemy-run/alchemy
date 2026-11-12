import type {
  MigrationRunnerRequest,
  MigrationRunnerResponse,
} from "@alchemy.run/aws/RDS/MigrationRunnerHandler";
import * as lambda from "@distilled.cloud/aws/lambda";
import * as s3 from "@distilled.cloud/aws/s3";
import * as ssm from "@distilled.cloud/aws/ssm";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { createInternalTags, createTagsList } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { databaseName, isStagePrefix, STORAGE_KEYS } from "../internal/selfhosted.ts";
import { createStatements, dropStatements, readyQuery } from "../internal/stageDatabase.ts";
import type { PlatformHandle } from "./Platform.ts";
import type { Providers } from "./Providers.ts";

export class StageDatabaseError extends Data.TaggedError("StageDatabaseError")<{
  readonly message: string;
}> {}

export class StageDatabaseProtected extends Data.TaggedError("StageDatabaseProtected")<{
  readonly message: string;
}> {}

export interface StageDatabaseProps {
  /** The platform whose database server holds this stage. */
  platform: PlatformHandle;
  /** The backend's instance name, which names the database and user. */
  instanceName: string;
  /** The stage user's password, as hex so it fits in a URL unescaped. */
  password: Redacted.Redacted<string>;
  /** Refuse to drop this database. RDS's own protection can't stop `DROP DATABASE`. */
  deletionProtection: boolean;
}

export interface StageDatabaseAttributes {
  /** The database, which is also the user's name. */
  databaseName: string;
  /** The connection URL, with no database name and no query string. */
  url: Redacted.Redacted<string>;
  /** Whether destroying this database is refused. */
  deletionProtection: boolean;
}

/** A shared server is only protected as a whole, so a stage's data needs its own guard. */
export const refuseProtected = Effect.fn(function* (output: StageDatabaseAttributes) {
  if (output.deletionProtection) {
    return yield* new StageDatabaseProtected({
      message: `Stage database ${output.databaseName} has deletionProtection on, so destroying it would lose its data. Set deletionProtection to false on Convex.Backend and deploy first.`,
    });
  }
});

export type StageDatabase = Resource<
  "Convex.StageDatabase",
  StageDatabaseProps,
  StageDatabaseAttributes,
  never,
  Providers
>;

/**
 * One stage's database and user on a shared `Convex.Platform` server, and its
 * prefix in the shared buckets. `Convex.Backend` creates one, so most stacks
 * never use this directly. Destroying it drops the database and deletes the
 * prefix, and only that prefix.
 *
 * A database has no tags, so an SSM parameter beside it names the resource that
 * owns it. A second resource for the same database is refused unless it adopts,
 * and adopting moves ownership, so the old resource's destroy leaves the data.
 *
 * The server is in private subnets, so the SQL runs through the platform's
 * in-VPC function. The master password is read from SSM here, on the deploying
 * machine, so it never lands in a stage's state.
 *
 * @internal
 *
 * @resource
 * @product StageDatabase
 */
export const StageDatabase = Resource<StageDatabase>("Convex.StageDatabase");

const MAX_LIST_PAGES = 1000;

/** The SSM parameter naming the resource that owns a stage database. */
const ownerParameterName = (host: string, database: string) =>
  `/alchemy/convex/stage-databases/${host}/${database}`;

export const StageDatabaseProvider = () =>
  Provider.effect(
    StageDatabase,
    Effect.gen(function* () {
      const invoke = yield* lambda.invoke;
      const getParameter = yield* ssm.getParameter;
      const putParameter = yield* ssm.putParameter;
      const deleteParameter = yield* ssm.deleteParameter;
      const listObjects = yield* s3.listObjectsV2;
      const deleteObjects = yield* s3.deleteObjects;

      /** `undefined` once the platform's server is gone, which takes every stage's data with it. */
      const connect = Effect.fn(function* (platform: PlatformHandle) {
        const database = platform.database;
        if (database === undefined) {
          return yield* new StageDatabaseError({
            message: "This platform has no database. Deploy it with a db.",
          });
        }
        const found = yield* getParameter({
          Name: database.passwordParameterName,
          WithDecryption: true,
        }).pipe(Effect.catchTag("ParameterNotFound", () => Effect.undefined));
        if (found === undefined) return undefined;
        const value = found.Parameter?.Value;
        if (value === undefined) {
          return yield* new StageDatabaseError({
            message: `SSM parameter ${database.passwordParameterName} has no value.`,
          });
        }
        return {
          functionName: database.runnerFunctionName,
          engine: database.engine,
          host: database.host,
          port: database.port,
          target: {
            dialect: database.engine,
            host: database.host,
            port: database.port,
            database: database.engine === "postgres" ? "postgres" : undefined,
            username: database.username,
            password: Redacted.isRedacted(value) ? Redacted.value(value) : value,
          },
        };
      });
      type Connection = NonNullable<Effect.Success<ReturnType<typeof connect>>>;

      const query = Effect.fn(function* (connection: Connection, sql: string) {
        const request: MigrationRunnerRequest = { op: "query", target: connection.target, sql };
        const response = yield* invoke({
          FunctionName: connection.functionName,
          Payload: JSON.stringify(request),
        });
        const body = response.Payload
          ? yield* response.Payload.pipe(
              Stream.decodeText(),
              Stream.mkString,
              Effect.mapError(
                (cause) =>
                  new StageDatabaseError({
                    message: `Failed to read the database runner's response: ${cause.message}`,
                  }),
              ),
            )
          : "";
        if (response.FunctionError !== undefined) {
          return yield* new StageDatabaseError({ message: "The database runner crashed." });
        }
        const parsed = yield* Effect.try({
          try: () => JSON.parse(body) as MigrationRunnerResponse,
          catch: () =>
            new StageDatabaseError({
              message: "The database runner returned a malformed response.",
            }),
        });
        if (!parsed.ok) {
          // The statement holds a password, so only the server's message is kept.
          return yield* new StageDatabaseError({
            message: `The database refused a statement: ${parsed.message.replaceAll(connection.target.password, "[REDACTED]")}`,
          });
        }
        return parsed.rows;
      });

      const exists = (connection: Connection, name: string) =>
        Effect.flatMap(readyQuery(connection.engine, name), (sql) => query(connection, sql)).pipe(
          Effect.map((rows) => rows.length > 0),
        );

      const ownerOf = (connection: Connection, name: string) =>
        getParameter({ Name: ownerParameterName(connection.host, name) }).pipe(
          // The SDK hands every parameter value back Redacted, plain strings too.
          Effect.map((found): string | undefined => {
            const value = found.Parameter?.Value;
            return Redacted.isRedacted(value) ? Redacted.value(value) : value;
          }),
          Effect.catchTag("ParameterNotFound", () => Effect.undefined),
        );

      const claim = Effect.fn(function* (
        connection: Connection,
        name: string,
        id: string,
        instanceId: string,
      ) {
        const Name = ownerParameterName(connection.host, name);
        // Tags only go on with the create; an existing marker is overwritten.
        yield* putParameter({
          Name,
          Value: instanceId,
          Type: "String",
          Tags: createTagsList(yield* createInternalTags(id)),
        }).pipe(
          Effect.catchTag("ParameterAlreadyExists", () =>
            putParameter({ Name, Value: instanceId, Type: "String", Overwrite: true }),
          ),
        );
      });

      const deletePrefix = Effect.fn(function* (bucket: string, instance: string) {
        let token: string | undefined;
        for (let page = 0; page < MAX_LIST_PAGES; page++) {
          const listed = yield* listObjects({
            Bucket: bucket,
            Prefix: `${instance}-`,
            ContinuationToken: token,
          }).pipe(Effect.catchTag("NoSuchBucket", () => Effect.undefined));
          // The platform took the bucket with it.
          if (listed === undefined) return;
          // `<instance>-*` also matches `<instance>-42-<uuid>/`, which is another stage.
          const keys = (listed.Contents ?? [])
            .map((object) => object.Key!)
            .filter((key) => isStagePrefix(instance, key));
          if (keys.length > 0) {
            const deleted = yield* deleteObjects({
              Bucket: bucket,
              Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
            });
            const failed = deleted.Errors ?? [];
            if (failed.length > 0) {
              return yield* new StageDatabaseError({
                message: `Failed to delete ${failed.length} objects from ${bucket}, such as ${failed[0]!.Key}: ${failed[0]!.Message ?? failed[0]!.Code}. Run destroy again.`,
              });
            }
          }
          token = listed.NextContinuationToken;
          if (token === undefined) return;
        }
        return yield* new StageDatabaseError({
          message: `Stopped after ${MAX_LIST_PAGES} pages deleting ${instance} from ${bucket}. Run destroy again.`,
        });
      });

      return {
        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          // A new name would be a new, empty database.
          if (olds !== undefined && olds.instanceName !== news.instanceName) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output, instanceId, previous }) {
          const connection = yield* connect(olds.platform);
          if (connection === undefined) return undefined;
          const name = output?.databaseName ?? databaseName(olds.instanceName);
          if (!(yield* exists(connection, name))) return undefined;
          const attrs: StageDatabaseAttributes = output ?? {
            databaseName: name,
            deletionProtection: olds.deletionProtection,
            // The password only lives in the owner's state.
            url: Redacted.make(
              `${connection.engine}://${name}@${connection.host}:${connection.port}`,
            ),
          };
          if (previous?.databaseName === name) return attrs;
          const owner = yield* ownerOf(connection, name);
          // A row already in state with no marker predates markers, so it's ours.
          if (owner === instanceId || (owner === undefined && output !== undefined)) return attrs;
          // Another resource, or none we know of, holds this database.
          return Unowned(attrs);
        }),
        // A stage's database lives on the platform's server and goes with it.
        list: () => Effect.succeed([]),
        reconcile: Effect.fn(function* ({ id, instanceId, news, session }) {
          const name = databaseName(news.instanceName);
          const password = Redacted.value(news.password);
          const connection = yield* connect(news.platform);
          if (connection === undefined) {
            return yield* new StageDatabaseError({
              message: `The platform's database password parameter ${news.platform.database!.passwordParameterName} is gone. Deploy the platform first.`,
            });
          }
          const present = yield* exists(connection, name);
          yield* session.note(`Ensuring database ${name}...`);
          for (const sql of yield* createStatements(connection.engine, name, password)) {
            if (present && sql.startsWith("CREATE DATABASE")) continue;
            yield* query(connection, sql);
          }
          yield* claim(connection, name, id, instanceId);
          return {
            databaseName: name,
            deletionProtection: news.deletionProtection,
            url: Redacted.make(
              `${connection.engine}://${name}:${password}@${connection.host}:${connection.port}`,
            ),
          };
        }),
        delete: Effect.fn(function* ({ olds, output, instanceId }) {
          const connection = yield* connect(olds.platform);
          // The platform went first and took the server and buckets with it.
          if (connection === undefined) return;
          const owner = yield* ownerOf(connection, output.databaseName);
          // Adopted by another resource since: the data is theirs now.
          if (owner !== undefined && owner !== instanceId) return;
          yield* refuseProtected(output);
          for (const sql of yield* dropStatements(connection.engine, output.databaseName)) {
            yield* query(connection, sql);
          }
          for (const key of STORAGE_KEYS) {
            yield* deletePrefix(olds.platform.storage[key].name, olds.instanceName);
          }
          yield* deleteParameter({
            Name: ownerParameterName(connection.host, output.databaseName),
          }).pipe(Effect.catchTag("ParameterNotFound", () => Effect.void));
        }),
      };
    }),
  );
