import * as DO from "@distilled.cloud/digitalocean";
import type { VectordbVectorDB } from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import { pollUntil, type PollBudget } from "../internal/poll.ts";
import type { Providers } from "../Providers.ts";

export type DatabaseSize = "small" | "medium" | "large";

export type DatabaseProps = {
  /**
   * Database name, at most 28 characters (it names the Weaviate cluster). A
   * change replaces the database.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Project the database belongs to. Updates in place. */
  projectId: string;
  /** Region. A change replaces the database. @default "tor1" */
  region?: string;
  /** Resource tier. Resizes in place. @default "small" */
  size?: DatabaseSize;
  /** Tags. Update in place. */
  tags?: string[];
};

export type Database = Resource<
  "DigitalOcean.VectorDB.Database",
  DatabaseProps,
  {
    /** Database id. */
    databaseId: string;
    /** Database name. */
    name: string;
    /** Region. */
    region: string;
    /** Resource tier. */
    size: string;
    /** HTTPS endpoint of the Weaviate API. */
    httpEndpoint: string;
    /** gRPC endpoint of the Weaviate API, `host:443`. */
    grpcEndpoint: string | undefined;
    /** Admin API key for the Weaviate API. */
    apiKey: Redacted.Redacted<string>;
  },
  never,
  Providers
>;

export type DatabaseAttributes = Database["Attributes"];

/**
 * A managed vector database: a Weaviate cluster DigitalOcean runs for you.
 * Connect to it from a runtime with `VectorDB.Connect`, or with any Weaviate
 * client using `httpEndpoint` and `apiKey`. `size`, `projectId` and `tags`
 * update in place; `name` and `region` replace the database.
 *
 * ### Creating a Vector Database
 * **Example:** A small database
 * ```typescript
 * const project = yield* DigitalOcean.Project("search", {});
 * const vectors = yield* DigitalOcean.VectorDB.Database("vectors", {
 *   projectId: project.projectId,
 *   size: "small",
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Vector-Databases
 *
 * @resource
 * @product Vector Databases
 * @category Databases
 */
export const Database = Resource<Database>("DigitalOcean.VectorDB.Database");

export class VectorDatabaseWaitTimedOut extends Data.TaggedError(
  "DigitalOcean.VectorDB.WaitTimedOut",
)<{
  readonly databaseId: string;
  readonly lastStatus: string | undefined;
}> {
  override get message() {
    return `Vector database ${this.databaseId} timed out waiting to become active (last status: ${this.lastStatus ?? "missing"}).`;
  }
}

// pending → creating → active takes about a minute (≈ 10 min budget).
const ACTIVE_POLL: PollBudget = { maxDelay: "10 seconds", times: 60 };

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 28 });

const observeById = (id: string) =>
  noneIfNotFound(DO.getVectorDatabase({ id }).pipe(Effect.map((r) => r.vector_db)));

const observeByName = (name: string) =>
  DO.listVectorDatabases({ per_page: 200 }).pipe(
    Effect.map((r) => Option.fromNullishOr((r.vector_dbs ?? []).find((db) => db.name === name))),
  );

const waitUntilActive = (id: string) =>
  pollUntil(observeById(id), {
    ...ACTIVE_POLL,
    until: (o): o is Option.Some<VectordbVectorDB> =>
      Option.isSome(o) && o.value.status === "active",
    onTimeout: (last) =>
      new VectorDatabaseWaitTimedOut({
        databaseId: id,
        lastStatus: Option.getOrUndefined(last)?.status,
      }),
  }).pipe(Effect.map((o) => o.value));

const toAttrs = (db: VectordbVectorDB, apiKey: Redacted.Redacted<string>): DatabaseAttributes => ({
  databaseId: db.id,
  name: db.name,
  region: db.region,
  size: db.size,
  httpEndpoint: db.endpoints?.http ?? "",
  grpcEndpoint: db.endpoints?.grpc,
  apiKey,
});

const credentialsOf = (id: string) =>
  DO.getVectorDatabaseCredentials({ id }).pipe(
    Effect.map(({ api_token }) =>
      typeof api_token === "string" ? Redacted.make(api_token) : api_token,
    ),
  );

export const DatabaseProvider = () =>
  Provider.succeed(Database, {
    stables: ["databaseId", "region"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ id, olds, output }) {
      const byId = output === undefined ? Option.none() : yield* observeById(output.databaseId);
      const generatedName = yield* physicalName(id);
      const observed = Option.isSome(byId)
        ? byId
        : olds.name === undefined
          ? yield* observeByName(generatedName)
          : Option.none<VectordbVectorDB>();
      if (Option.isNone(observed)) return undefined;
      const apiKey = output?.apiKey ?? (yield* credentialsOf(observed.value.id));
      return toAttrs(observed.value, apiKey);
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (news.name !== olds.name || (news.region ?? "tor1") !== (olds.region ?? "tor1")) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? output?.name ?? (yield* physicalName(id));
      const size = news.size ?? "small";
      const byId = output === undefined ? Option.none() : yield* observeById(output.databaseId);
      const observed = Option.isSome(byId)
        ? byId
        : news.name === undefined
          ? yield* observeByName(name)
          : Option.none<VectordbVectorDB>();
      const created = yield* Option.match(observed, {
        onSome: Effect.succeed,
        onNone: () =>
          DO.createVectorDatabase({
            name,
            project_id: news.projectId,
            region: news.region ?? "tor1",
            size,
            tags: news.tags,
          }).pipe(Effect.map((r) => r.vector_db)),
      });
      let db = yield* waitUntilActive(created.id);

      if (db.size !== size) {
        yield* DO.vectorDatabasesPostResize({ id: db.id, size });
        db = yield* waitUntilActive(db.id);
      }
      if (db.project_id !== news.projectId) {
        yield* DO.updateVectorDatabase({ id: db.id, project_id: news.projectId });
      }
      const tags = [...(news.tags ?? [])].sort();
      if (JSON.stringify([...(db.tags ?? [])].sort()) !== JSON.stringify(tags)) {
        yield* DO.updateVectorDatabaseTags({ id: db.id, tags });
      }
      const final = yield* waitUntilActive(db.id);
      const apiKey = yield* credentialsOf(final.id);
      return toAttrs(final, apiKey);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteVectorDatabase({ id: output.databaseId }));
    }),
  });
