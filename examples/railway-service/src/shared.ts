import * as Railway from "alchemy/Railway";
import * as Redacted from "effect/Redacted";

export const VOLUME_PATH = "/data";
export const MARKER_FILE = `${VOLUME_PATH}/hello.txt`;
export const MARKER = "hello-from-railway-worker";
export const API_PORT = 3000;
export const SECRET_NAME = "RAILWAY_EXAMPLE_MARKER";
export const OBJECT_KEY = "example.txt";
export const REDIS_KEY = "example-marker";

const PING_SOURCE = `Bun.serve({
  hostname: "0.0.0.0",
  port: Number(process.env.PORT ?? 3000),
  fetch() {
    return new Response("ok");
  },
});
`;

/**
 * Parent Project every other resource shares. Name is generated.
 * Production is `Site.environmentId` — do not recreate it as an
 * Environment.
 */
export const Site = Railway.Project("Site");

/**
 * Extra staging environment. Production already exists on {@link Site}.
 * Empty on create (no `sourceEnvironmentId`) so it does not clone
 * Postgres / Redis / Services.
 */
export const Staging = Railway.Environment("Staging", {
  project: Site,
  name: "staging",
});

/**
 * Shared project variable. Railway injects it as env
 * {@link SECRET_NAME}. {@link Api} reads it with `Config.string`.
 */
export const Marker = Railway.Variable("Marker", {
  project: Site,
  name: SECRET_NAME,
  value: Redacted.make(MARKER),
});

/**
 * Block disk {@link Worker} mounts at {@link VOLUME_PATH}. A Volume
 * attaches to one Service.
 */
export const Disk = Railway.Volume("Disk", {
  project: Site,
  mountPath: VOLUME_PATH,
});

/**
 * Official SSL Postgres. `public` (default) opens a TCP proxy for
 * laptop access. In-Service connections use `{name}.railway.internal`
 * via {@link Railway.ConnectPostgres}.
 */
export const Db = Railway.Postgres("Db", { project: Site });

/**
 * Official MySQL. Same shape as {@link Db}. In-Service connections
 * use {@link Railway.ConnectMySQL}.
 */
export const Mysql = Railway.MySQL("Mysql", { project: Site });

/**
 * Railway variable-reference template (`${{Db.DATABASE_URL}}`). Stored
 * unrendered; Railway interpolates it. Distinct from
 * {@link Railway.ConnectPostgres}, which packs a typed URI.
 */
export const DatabaseUrl = Railway.Variable("DatabaseUrl", {
  project: Site,
  name: "APP_DATABASE_URL",
  value: Railway.ref("Db", "DATABASE_URL"),
});

/**
 * Canvas Function: one TypeScript file on the Bun function runtime.
 * No Docker, no GitHub. Distinct from Effect-native {@link Api}.
 */
export const Ping = Railway.Function("Ping", {
  project: Site,
  source: PING_SOURCE,
});

/**
 * Redis. {@link CacheProxy} exposes it on `*.proxy.rlwy.net`.
 * {@link Api} binds {@link Railway.ReadWriteRedis}.
 */
export const Cache = Railway.Redis("Cache", { project: Site });

/**
 * Public TCP proxy for {@link Cache} (Postgres already creates one
 * when `public` is true).
 */
export const CacheProxy = Railway.TcpProxy("CacheProxy", {
  redis: Cache,
  environment: Site,
  applicationPort: 6379,
});

/**
 * S3-compatible bucket. {@link Api} binds Put/Get/Head/List/Delete.
 */
export const Data = Railway.Bucket("Data", { project: Site });
