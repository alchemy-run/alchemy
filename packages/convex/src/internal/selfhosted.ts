import { createHash } from "node:crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export const STORAGE_ENV = {
  files: "S3_STORAGE_FILES_BUCKET",
  modules: "S3_STORAGE_MODULES_BUCKET",
  exports: "S3_STORAGE_EXPORTS_BUCKET",
  snapshotImports: "S3_STORAGE_SNAPSHOT_IMPORTS_BUCKET",
  search: "S3_STORAGE_SEARCH_BUCKET",
} as const;

export type StorageKey = keyof typeof STORAGE_ENV;

export const STORAGE_KEYS = Object.keys(STORAGE_ENV) as StorageKey[];

/** Set by the resource. Accepting these from a user would break the backend or leak a secret. */
export const RESERVED_ENV = [
  "INSTANCE_NAME",
  "INSTANCE_SECRET",
  "CONVEX_CLOUD_ORIGIN",
  "CONVEX_SITE_ORIGIN",
  "POSTGRES_URL",
  "MYSQL_URL",
  "AWS_REGION",
  "DO_NOT_REQUIRE_SSL",
  "PG_CA_FILE",
  "MYSQL_CA_FILE",
  ...Object.values(STORAGE_ENV),
] as const;

export type ReservedEnv = (typeof RESERVED_ENV)[number];

export type BackendEnv = Record<string, string> & { [K in ReservedEnv]?: never };

export interface BackendSize {
  /** CPU units, where 1024 is one vCPU. */
  cpu: number;
  /** Memory in MiB. */
  memory: number;
}

export class ReservedEnvError extends Data.TaggedError("ReservedEnvError")<{
  readonly message: string;
}> {}

export class UnpinnedImage extends Data.TaggedError("UnpinnedImage")<{
  readonly message: string;
}> {}

export class InstanceNameChanged extends Data.TaggedError("InstanceNameChanged")<{
  readonly message: string;
}> {}

export class InvalidDatabaseUrl extends Data.TaggedError("InvalidDatabaseUrl")<{
  readonly message: string;
}> {}

export class InvalidStageName extends Data.TaggedError("InvalidStageName")<{
  readonly message: string;
}> {}

const MAX_INSTANCE_NAME = 48;
/** A hostname label is at most 63, and `<stage>-cloud` has to fit. */
const MAX_STAGE_LENGTH = 57;

const shortHash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 8);

/** The backend's `INSTANCE_NAME`. Prefixes admin keys and names the database. */
export const instanceNameOf = (stack: string, stage: string) => {
  const name = `${stack}-${stage}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name.length <= MAX_INSTANCE_NAME
    ? name
    : `${name.slice(0, MAX_INSTANCE_NAME - 9).replace(/-+$/, "")}-${shortHash(name)}`;
};

export const databaseName = (instance: string) => instance.replace(/-/g, "_");

/** An IAM pattern for one instance's objects. `<instance>-*` would reach `<instance>-42-<uuid>/`. */
export const storagePrefixPattern = (instance: string) =>
  `${instance}-????????-????-????-????-????????????/*`;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** The same test as {@link storagePrefixPattern}, for keys already listed. */
export const isStagePrefix = (instance: string, key: string) =>
  key.startsWith(`${instance}-`) && new RegExp(`^${UUID}/`).test(key.slice(instance.length + 1));

/** Settings that follow the task's size. Ported from sentia's `backendTuning()`. */
export const backendTuning = ({ cpu, memory }: BackendSize): Record<string, string> => {
  const vcpu = cpu / 1024;
  const atLeast = (min: number, n: number) => String(Math.max(min, Math.ceil(n)));
  const mib = (n: number) => String(Math.round(n) * 1024 * 1024);
  return {
    RUNTIME_WORKER_THREADS: atLeast(2, vcpu * 2),
    V8_THREADS: atLeast(2, vcpu),
    FUNRUN_ISOLATE_ACTIVE_THREADS: atLeast(2, vcpu * 2),
    MAX_ISOLATE_WORKERS: atLeast(8, vcpu * 8),
    ISOLATE_QUEUE_SIZE: atLeast(64, vcpu * 64),
    SCHEDULED_JOB_EXECUTION_PARALLELISM: atLeast(2, vcpu * 4),
    ANALYZE_CONCURRENCY: atLeast(1, vcpu * 2),
    MYSQL_MAX_CONNECTIONS: atLeast(8, vcpu * 16),
    UDF_CACHE_MAX_SIZE: mib(memory / 32),
    INDEX_CACHE_SIZE: mib(memory / 16),
    FUNRUN_CODE_CACHE_SIZE: mib(memory / 32),
    FUNRUN_MODULE_CACHE_SIZE: mib(memory / 32),
    FUNRUN_INDEX_CACHE_SIZE: mib(memory / 64),
    SOURCE_MAP_CACHE_MAX_SIZE_BYTES: mib(memory / 64),
  };
};

const BACKEND_DEFAULTS: Record<string, string> = {
  APPLICATION_MAX_CONCURRENT_MUTATIONS: "16",
  APPLICATION_MAX_CONCURRENT_NODE_ACTIONS: "16",
  APPLICATION_MAX_CONCURRENT_QUERIES: "16",
  APPLICATION_MAX_CONCURRENT_V8_ACTIONS: "16",
  DISABLE_BEACON: "true",
  DISABLE_METRICS_ENDPOINT: "true",
  DOCUMENT_RETENTION_DELAY: "172800",
  // Matches the ALB's idle timeout, so neither side cuts a websocket first.
  HTTP_SERVER_TIMEOUT_SECONDS: "300",
  RUST_LOG: "info",
};

/** Defaults, then tuning, then the user. */
export const backendEnv = (input: { size: BackendSize; env: Record<string, string> }) => ({
  ...BACKEND_DEFAULTS,
  ...backendTuning(input.size),
  ...input.env,
});

export const assertNoReservedEnv = Effect.fn(function* (env: Record<string, string>) {
  const reserved = Object.keys(env).filter((name) =>
    (RESERVED_ENV as readonly string[]).includes(name),
  );
  if (reserved.length > 0) {
    return yield* new ReservedEnvError({
      message: `Convex.Backend sets ${reserved.join(", ")} itself. Remove them from env.`,
    });
  }
});

export const assertPinnedImage = Effect.fn(function* (image: string) {
  if (!/@sha256:[0-9a-f]{64}$/.test(image)) {
    return yield* new UnpinnedImage({
      message: `image must be pinned by digest, like repo:tag@sha256:<digest>, because Convex migrations only go forward and a floating tag can move on its own. Got ${image}.`,
    });
  }
});

export const assertInstanceNameUnchanged = Effect.fn(function* (
  old: string | undefined,
  next: string,
) {
  if (old !== undefined && old !== next) {
    return yield* new InstanceNameChanged({
      message: `The instance name would change from ${old} to ${next}, which points the backend at a new, empty database. Set instanceName to ${old} to keep the data, or destroy this backend first.`,
    });
  }
});

/**
 * The backend adds its own database name and query string to its URL. The error
 * says nothing about the value, which holds a password.
 */
export const withoutDatabaseName = Effect.fn(function* (url: Redacted.Redacted<string>) {
  const parsed = URL.parse(Redacted.value(url));
  if (parsed === null || parsed.host.length === 0) {
    return yield* new InvalidDatabaseUrl({
      message: "db.url isn't a valid URL. Expected postgres://user:password@host:port.",
    });
  }
  const auth = parsed.username.length > 0 ? `${parsed.username}:${parsed.password}@` : "";
  return Redacted.make(`${parsed.protocol}//${auth}${parsed.host}`);
});

/**
 * What a url-mode backend connects to. Postgres negotiates TLS whenever a server
 * offers it, and `DO_NOT_REQUIRE_SSL` alone doesn't stop that, so opting out needs
 * `sslmode=disable` as well.
 */
export const databaseUrl = Effect.fn(function* (
  engine: "postgres" | "mysql",
  url: Redacted.Redacted<string>,
  requireSsl: boolean,
) {
  const bare = yield* withoutDatabaseName(url);
  return requireSsl || engine !== "postgres"
    ? bare
    : Redacted.make(`${Redacted.value(bare)}?sslmode=disable`);
});

/**
 * Hostnames for a stage. Stage hosts stay flat under the domain so a single
 * `*.<domain>` certificate covers them.
 */
export const stageHosts = (domain: string, stage: string, isProd: boolean) =>
  isProd
    ? { web: domain, cloud: `cloud.${domain}`, site: `site.${domain}` }
    : {
        web: `${stage}.${domain}`,
        cloud: `${stage}-cloud.${domain}`,
        site: `${stage}-site.${domain}`,
      };

export const assertStageHosts = Effect.fn(function* (stage: string) {
  if (stage.length > MAX_STAGE_LENGTH || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(stage)) {
    return yield* new InvalidStageName({
      message: `Stage ${stage} must fit in a hostname: lowercase letters, digits and hyphens, at most ${MAX_STAGE_LENGTH} characters.`,
    });
  }
  if (/-(cloud|site)$/.test(stage)) {
    return yield* new InvalidStageName({
      message: `Stage ${stage} would take another stage's Convex host, so it can't end in -cloud or -site.`,
    });
  }
});

/**
 * The first of two consecutive listener rule priorities for an instance. Stages
 * share a listener, so this comes from the name rather than from a counter. A
 * clash fails the deploy with PriorityInUse rather than routing wrongly.
 */
export const listenerPriority = (instance: string) =>
  1 + 2 * (Number.parseInt(shortHash(instance), 16) % 24_000);

export class SqliteInProduction extends Data.TaggedError("SqliteInProduction")<{
  readonly message: string;
}> {}
