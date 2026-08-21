import { Services } from "@distilled.cloud/fly-io";
import type {
  ClusterCredentials,
  GetClusterResponse,
  ManagedCluster,
} from "@distilled.cloud/fly-io/mpg";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { resolveOrgSlug } from "./Environment.ts";
import {
  createFlyAppName,
  matchesAlchemyPhysicalName,
  sanitizeFlyAppName,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";

export const DEFAULT_POSTGRES_PLAN = "basic";
export const DEFAULT_VOLUME_GB = 10;
export const DATABASE_URL_SECRET = "DATABASE_URL";
export const DIRECT_DATABASE_URL_SECRET = "DIRECT_DATABASE_URL";

export type PostgresPlan =
  | "basic"
  | "starter"
  | "launch"
  | "scale"
  | "performance"
  | (string & {});

export interface PostgresProps {
  /**
   * Region the cluster lives in (`iad`, `ord`, `sjc`, …). Required.
   * The cluster is regional; a {@link App} is global. Changing it
   * replaces the cluster.
   */
  region: string;
  /**
   * Hardware plan. `basic` is 2 shared vCPUs / 1 GB RAM.
   *
   * @default "basic"
   */
  plan?: PostgresPlan;
  /**
   * Cluster name. Unique in the organization. If omitted, a unique
   * name is generated from the stack, stage and logical ID. Changing
   * it replaces the cluster.
   */
  name?: string;
  /**
   * Organization slug. Defaults to the current token's org. Changing
   * it replaces the cluster.
   */
  orgSlug?: string;
  /**
   * Initial volume size in GB. Fly defaults to 10. Create-only.
   *
   * @default 10
   */
  volumeSizeGb?: number;
  /**
   * Enable PostGIS. Create-only.
   *
   * @default false
   */
  postgis?: boolean;
  /**
   * Postgres major version (`16` or `17`). Create-only.
   *
   * @default 16
   */
  pgMajorVersion?: number | string;
}

export type Postgres = Resource<
  "Fly.Postgres",
  PostgresProps,
  {
    /** Fly Managed Postgres cluster id. */
    clusterId: string;
    /** Cluster name (unique in the org). */
    name: string;
    /** Observed status (`creating`, `ready`, `error`, `deleted`, …). */
    status: string | undefined;
    /** Region the cluster lives in. */
    region: string;
    /** Observed hardware plan. */
    plan: string | undefined;
    /** Organization slug. */
    orgSlug: string | undefined;
    /** Observed disk size in GB. */
    disk: number | undefined;
    /** Whether PostGIS is enabled. */
    postgisEnabled: boolean | undefined;
    /** Observed engine string, if the API returned one. */
    engine: string | undefined;
    /** Observed replica count. */
    replicas: number | undefined;
    /** Internal MPG cluster hash id, if the API returned one. */
    mpgdClusterId: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Fly.Postgres is a Managed Postgres (MPG) cluster. It is billed.
 * Do not wrap unmanaged `fly postgres`.
 *
 * @resource
 * @see https://fly.io/docs/mpg/create-and-connect/
 *
 * @section Create a cluster
 * `region` is required. Alchemy generates a unique name unless you
 * pass one. Omit `name` in tests and CI.
 *
 * @example Generated name
 * ```typescript
 * const db = yield* Fly.Postgres("Db", {
 *   region: "iad",
 * });
 * ```
 *
 * :::caution[Billed]
 * Managed Postgres is billed. Basic is about $38 per month.
 * :::
 *
 * @section Plan
 * `plan` is the hardware size: `basic`, `starter`, `launch`,
 * `scale`, `performance`. Default is `basic`.
 *
 * @example Starter
 * ```typescript
 * const db = yield* Fly.Postgres("Db", {
 *   region: "iad",
 *   plan: "starter",
 * });
 * ```
 *
 * :::note[Create-only]
 * Changing `plan` later is ignored. Fly has no cluster update API.
 * :::
 *
 * @section Region
 * The cluster is regional. An {@link App} is global. Pass `region`
 * on the cluster, not on the App.
 *
 * @example Pin a region
 * ```typescript
 * const db = yield* Fly.Postgres("Db", {
 *   region: "lhr",
 * });
 * ```
 *
 * :::caution[Changing `region` replaces the cluster]
 * A new cluster is created in the new region. The old cluster is
 * deleted. Data is not copied.
 * :::
 *
 * @section Volume size
 * `volumeSizeGb` is the initial disk. Fly defaults to 10 GB.
 *
 * @example 20 GB
 * ```typescript
 * const db = yield* Fly.Postgres("Db", {
 *   region: "iad",
 *   volumeSizeGb: 20,
 * });
 * ```
 *
 * :::note[Create-only]
 * Changing `volumeSizeGb` later is ignored.
 * :::
 *
 * @section PostGIS
 * `postgis: true` enables PostGIS at create.
 *
 * @example Enable PostGIS
 * ```typescript
 * const db = yield* Fly.Postgres("Db", {
 *   region: "iad",
 *   postgis: true,
 * });
 * ```
 *
 * :::note[Create-only]
 * Flipping `postgis` later is ignored.
 * :::
 *
 * @section Attach
 * {@link AttachPostgres} writes `DATABASE_URL` (and
 * `DIRECT_DATABASE_URL` if present) as App secrets. A {@link Service}
 * reads them with `Config.redacted("DATABASE_URL")`. Do not pass
 * `env: {}`.
 *
 * @example Attach from a Service
 * ```typescript
 * import * as Config from "effect/Config";
 *
 * export default class Api extends Fly.Service<Api>()(
 *   "Api",
 *   { app: Site, main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     yield* Fly.AttachPostgres(Db);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const databaseUrl = yield* Config.redacted("DATABASE_URL");
 *         return HttpServerResponse.text("ok");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Fly.AttachPostgresLive)),
 * ) {}
 * ```
 */
export const Postgres = Resource<Postgres>("Fly.Postgres");

export class PostgresNotCreated extends Data.TaggedError(
  "Fly.PostgresNotCreated",
)<{
  name: string;
  orgSlug: string;
}> {}

export class PostgresCreateFailed extends Data.TaggedError(
  "Fly.PostgresCreateFailed",
)<{
  clusterId: string;
  status: string;
}> {}

export class PostgresCredentialsMissing extends Data.TaggedError(
  "Fly.PostgresCredentialsMissing",
)<{
  clusterId: string;
}> {}

class PostgresPending extends Data.TaggedError("Fly.PostgresPending")<{
  clusterId: string;
  status: string;
}> {}

const backoff = Schedule.min([
  Schedule.exponential(Duration.millis(500), 1.5),
  Schedule.spaced(Duration.seconds(5)),
]);

export const isLiveCluster = (
  cluster: ManagedCluster | undefined,
): cluster is ManagedCluster =>
  cluster !== undefined &&
  (cluster.id ?? "").length > 0 &&
  cluster.status !== "deleted";

export const unwrapSensitive = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined => {
  if (value === undefined) return undefined;
  return Redacted.isRedacted(value) ? Redacted.value(value) : value;
};

const toAttrs = (
  cluster: ManagedCluster,
  fallback?: { name?: string; orgSlug?: string },
): Postgres["Attributes"] => ({
  clusterId: cluster.id ?? "",
  name: cluster.name ?? fallback?.name ?? "",
  status: cluster.status,
  region: cluster.region ?? "",
  plan: cluster.plan,
  orgSlug: cluster.organization?.slug ?? fallback?.orgSlug,
  disk: cluster.disk,
  postgisEnabled: cluster.postgis_enabled,
  engine: cluster.engine,
  replicas: cluster.replicas,
  mpgdClusterId: cluster.mpgd_cluster_id,
});

const resolveName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return sanitizeFlyAppName(name);
    if (existing !== undefined) return existing;
    return yield* createFlyAppName(id);
  });

export const getLiveCluster = (clusterId: string) =>
  Services.mpg.getClusterById({ id: clusterId }).pipe(
    Effect.map((res) => (isLiveCluster(res.data) ? res.data : undefined)),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

export const getClusterResponse = (clusterId: string) =>
  Services.mpg.getClusterById({ id: clusterId }).pipe(
    Effect.map((res): GetClusterResponse | undefined =>
      isLiveCluster(res.data) ? res : undefined,
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const listOrgClusters = (orgSlug: string) =>
  Services.mpg.listClusters({ org_slug: orgSlug }).pipe(
    Effect.map((res) => (res.data ?? []).filter((row) => isLiveCluster(row))),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed([] as ManagedCluster[]),
    ),
  );

const findByName = (orgSlug: string, name: string) =>
  listOrgClusters(orgSlug).pipe(
    Effect.map((rows) => rows.find((row) => row.name === name)),
  );

const waitUntilReady = (clusterId: string) =>
  getLiveCluster(clusterId).pipe(
    Effect.flatMap((cluster) => {
      if (cluster === undefined) {
        return Effect.fail(
          new PostgresPending({ clusterId, status: "missing" }),
        );
      }
      if (cluster.status === "ready") return Effect.succeed(cluster);
      if (cluster.status === "error") {
        return Effect.fail(
          new PostgresCreateFailed({
            clusterId,
            status: cluster.status,
          }),
        );
      }
      return Effect.fail(
        new PostgresPending({
          clusterId,
          status: cluster.status ?? "creating",
        }),
      );
    }),
    Effect.retry({
      while: (e) => e._tag === "Fly.PostgresPending",
      times: 10,
      schedule: backoff,
    }),
    Effect.catchTag("Fly.PostgresPending", () => getLiveCluster(clusterId)),
  );

const waitUntilGone = (clusterId: string) =>
  Services.mpg.getClusterById({ id: clusterId }).pipe(
    Effect.map(
      (res) => res.data === undefined || res.data.status === "deleted",
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(true)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (gone) => gone,
      times: 10,
    }),
  );

const desiredPlan = (plan: PostgresPlan | undefined) =>
  plan ?? DEFAULT_POSTGRES_PLAN;

const desiredDisk = (size: number | undefined) =>
  size === undefined ? DEFAULT_VOLUME_GB : Math.max(1, size);

const pgMajor = (value: number | string | undefined) =>
  value === undefined ? undefined : String(value);

export const credentialsUri = (
  credentials: ClusterCredentials | undefined,
): string | undefined => unwrapSensitive(credentials?.pgbouncer_uri);

export const directUri = (
  cluster: ManagedCluster | undefined,
  credentials: ClusterCredentials | undefined,
): string | undefined => {
  const user = credentials?.user;
  const password = unwrapSensitive(credentials?.password);
  const dbname = credentials?.dbname;
  const hash = cluster?.mpgd_cluster_id;
  if (
    user === undefined ||
    user.length === 0 ||
    password === undefined ||
    password.length === 0 ||
    dbname === undefined ||
    dbname.length === 0 ||
    hash === undefined ||
    hash.length === 0
  ) {
    return undefined;
  }
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@direct.${hash}.flympg.net/${dbname}`;
};

const putSecret = (appName: string, name: string, value: string) =>
  Services.machines
    .secretCreate({
      app_name: appName,
      secret_name: name,
      value,
    })
    .pipe(
      Effect.asVoid,
      Effect.catchTag("Conflict", () =>
        Services.machines
          .secretsUpdate({
            app_name: appName,
            values: { [name]: value },
          })
          .pipe(Effect.asVoid),
      ),
    );

class PostgresCredentialsPending extends Data.TaggedError(
  "Fly.PostgresCredentialsPending",
)<{
  clusterId: string;
}> {}

/**
 * Write `DATABASE_URL` (and `DIRECT_DATABASE_URL` if present) onto an
 * App and record the MPG attachment. Called from {@link AttachPostgres}
 * and from tests after deploy.
 */
export const attachPostgresSecrets = Effect.fn(function* (
  appName: string,
  clusterId: string,
  variableName: string = DATABASE_URL_SECRET,
) {
  if (appName.length === 0 || clusterId.length === 0) return;
  const creds = yield* getClusterResponse(clusterId).pipe(
    Effect.flatMap((res) => {
      const uri = credentialsUri(res?.credentials);
      if (uri !== undefined && uri.length > 0) {
        return Effect.succeed({
          uri,
          direct: directUri(res?.data, res?.credentials),
        });
      }
      return Effect.fail(new PostgresCredentialsPending({ clusterId }));
    }),
    Effect.retry({
      while: (e) => e._tag === "Fly.PostgresCredentialsPending",
      times: 10,
      schedule: backoff,
    }),
    Effect.catchTag("Fly.PostgresCredentialsPending", () =>
      Effect.succeed(undefined),
    ),
  );
  if (creds === undefined) {
    return yield* new PostgresCredentialsMissing({ clusterId });
  }
  yield* putSecret(appName, variableName, creds.uri);
  if (creds.direct !== undefined) {
    yield* putSecret(appName, DIRECT_DATABASE_URL_SECRET, creds.direct);
  }
  yield* Services.mpg
    .createAttachment({
      id: clusterId,
      app_name: appName,
    })
    .pipe(
      Effect.asVoid,
      Effect.catchTag("Conflict", () => Effect.void),
      Effect.retry({
        while: (e) => e._tag === "NotFound",
        times: 8,
        schedule: backoff,
      }),
      Effect.catchTag("NotFound", () => Effect.void),
    );
});

export const PostgresProvider = () =>
  Provider.succeed(Postgres, {
    stables: ["clusterId", "name", "region", "orgSlug"],
    nuke: { dependsOn: ["Fly.App"] },

    diff: Effect.fn(function* ({ news, output }) {
      if (news === undefined || !isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      const desiredName =
        news.name !== undefined ? sanitizeFlyAppName(news.name) : output.name;
      const nameChanged = desiredName !== output.name;
      const regionChanged = news.region !== output.region;
      const orgChanged =
        news.orgSlug !== undefined && news.orgSlug !== output.orgSlug;
      if (nameChanged || regionChanged || orgChanged) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const found =
        output?.clusterId !== undefined && output.clusterId.length > 0
          ? yield* getLiveCluster(output.clusterId)
          : undefined;
      if (found !== undefined) return toAttrs(found, output);
      const name = yield* resolveName(id, olds?.name, output?.name);
      const orgSlug =
        olds?.orgSlug ?? output?.orgSlug ?? (yield* resolveOrgSlug());
      const byName = yield* findByName(orgSlug, name);
      if (byName === undefined) return undefined;
      const attrs = toAttrs(byName, { name, orgSlug });
      if (output !== undefined) return attrs;
      return matchesAlchemyPhysicalName(name) ? attrs : Unowned(attrs);
    }),

    list: Effect.fn(function* () {
      const orgSlug = yield* resolveOrgSlug();
      const rows = yield* listOrgClusters(orgSlug);
      return rows.flatMap((cluster) => {
        if (!matchesAlchemyPhysicalName(cluster.name)) return [];
        return [toAttrs(cluster, { orgSlug })];
      });
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const props = news ?? ({} as PostgresProps);
      const name = yield* resolveName(id, props.name, output?.name);
      const orgSlug = props.orgSlug ?? (yield* resolveOrgSlug());
      const region = props.region ?? output?.region;

      let current =
        output?.clusterId !== undefined && output.clusterId.length > 0
          ? yield* getLiveCluster(output.clusterId)
          : undefined;
      if (
        current === undefined &&
        (output === undefined ||
          output.name !== name ||
          output.orgSlug !== orgSlug)
      ) {
        current = yield* findByName(orgSlug, name);
      }

      if (current === undefined) {
        if (region === undefined || region.length === 0) {
          return yield* new PostgresNotCreated({ name, orgSlug });
        }
        const created = yield* Services.mpg
          .createCluster({
            org_slug: orgSlug,
            name,
            region,
            plan: desiredPlan(props.plan),
            storage_in_gb: desiredDisk(props.volumeSizeGb),
            postgis_enabled: props.postgis,
            pg_major_version: pgMajor(props.pgMajorVersion),
          })
          .pipe(
            Effect.map((res) => res.data),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current = isLiveCluster(created)
          ? created
          : yield* findByName(orgSlug, name);
      }

      if (current === undefined || current.id === undefined) {
        return yield* new PostgresNotCreated({ name, orgSlug });
      }

      if (current.status !== "ready") {
        current =
          (yield* waitUntilReady(current.id)) ??
          (yield* getLiveCluster(current.id)) ??
          current;
      }

      if (current.status === "error") {
        return yield* new PostgresCreateFailed({
          clusterId: current.id ?? "",
          status: current.status,
        });
      }

      return toAttrs(current, { name, orgSlug });
    }),

    delete: Effect.fn(function* ({ output }) {
      const clusterId = output.clusterId;
      if (clusterId.length === 0) return;
      const orgSlug = output.orgSlug ?? (yield* resolveOrgSlug());
      const observed = yield* getClusterResponse(clusterId);
      const apps = observed?.data?.attached_apps ?? [];
      yield* Effect.forEach(
        apps,
        (app) => {
          const appName = app.name;
          if (appName === undefined || appName.length === 0) {
            return Effect.void;
          }
          return Effect.gen(function* () {
            yield* Services.mpg
              .deleteAttachment({ id: clusterId, app_name: appName })
              .pipe(Effect.catchTag("NotFound", () => Effect.void));
            yield* Services.machines
              .secretDelete({
                app_name: appName,
                secret_name: DATABASE_URL_SECRET,
              })
              .pipe(Effect.catchTag("NotFound", () => Effect.void));
            yield* Services.machines
              .secretDelete({
                app_name: appName,
                secret_name: DIRECT_DATABASE_URL_SECRET,
              })
              .pipe(Effect.catchTag("NotFound", () => Effect.void));
          });
        },
        { concurrency: 4 },
      );
      yield* Services.mpg
        .destroyCluster({ org_slug: orgSlug, id: clusterId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(clusterId);
    }),
  });
