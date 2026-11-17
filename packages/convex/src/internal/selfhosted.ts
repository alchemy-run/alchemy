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

export class InvalidHostTemplate extends Data.TaggedError("InvalidHostTemplate")<{
  readonly message: string;
}> {}

export class InvalidHosts extends Data.TaggedError("InvalidHosts")<{
  readonly message: string;
}> {}

const MAX_INSTANCE_NAME = 48;
/** A stage is one hostname label, which holds at most 63 characters. */
const MAX_STAGE_LENGTH = 63;
/** A stage with one of these names would claim the production backend's host. */
const RESERVED_STAGE_LABELS = ["cloud", "site"];

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
 * How a platform names a stage's hosts. `{stage}`, `{app}` and `{domain}` are
 * filled in. `{stage}` and `{app}` go in the first label, the only one a
 * wildcard certificate can cover, and the template ends in `.{domain}`.
 */
export interface HostTemplate {
  /**
   * The stage's website. Nothing on the platform serves it; read it with
   * `stageHosts` to name the site.
   * @default "{stage}.{domain}"
   */
  web?: string;
  /**
   * The Convex API.
   * @default "{stage}.cloud.{domain}"
   */
  cloud?: string;
  /**
   * HTTP actions.
   * @default "{stage}.site.{domain}"
   */
  site?: string;
}

/** A template with every host spelled out, as a platform hands it to its stages. */
export type ResolvedHostTemplate = Required<HostTemplate>;

export const DEFAULT_HOSTS: ResolvedHostTemplate = {
  web: "{stage}.{domain}",
  cloud: "{stage}.cloud.{domain}",
  site: "{stage}.site.{domain}",
};

export const resolveHostTemplate = (template?: HostTemplate): ResolvedHostTemplate => ({
  web: template?.web ?? DEFAULT_HOSTS.web,
  cloud: template?.cloud ?? DEFAULT_HOSTS.cloud,
  site: template?.site ?? DEFAULT_HOSTS.site,
});

const PLACEHOLDERS = ["{stage}", "{app}", "{domain}"];
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const fill = (template: string, values: { stage: string; app: string; domain: string }) =>
  template
    .replaceAll("{stage}", values.stage)
    .replaceAll("{app}", values.app)
    .replaceAll("{domain}", values.domain);

/** What's wrong with a template, or `undefined` when it can name every stage. */
export const hostTemplateProblem = (template?: HostTemplate): string | undefined => {
  const resolved = resolveHostTemplate(template);
  for (const [name, value] of Object.entries(resolved)) {
    const unknown = (value.match(/\{[^}]*\}/g) ?? []).filter((p) => !PLACEHOLDERS.includes(p));
    if (unknown.length > 0) {
      return `The ${name} host template ${value} uses ${unknown.join(", ")}. Use {stage}, {app} and {domain}.`;
    }
    if (!value.endsWith(".{domain}") || value.indexOf("{domain}") !== value.length - 8) {
      return `The ${name} host template ${value} must end in .{domain}, and only there.`;
    }
    const [first = "", ...middle] = value.slice(0, -".{domain}".length).split(".");
    if (!first.includes("{stage}")) {
      return `The ${name} host template ${value} must put {stage} in its first label, so stages get different hosts under one wildcard certificate.`;
    }
    if (middle.some((label) => label.includes("{"))) {
      return `The ${name} host template ${value} can only use {stage} and {app} in its first label, the one a wildcard certificate covers.`;
    }
    if (!/^[a-z0-9-]*$/.test(first.replace(/\{stage\}|\{app\}/g, ""))) {
      return `The ${name} host template ${value} has a first label that can't be part of a hostname.`;
    }
    if (middle.some((label) => !LABEL.test(label))) {
      return `The ${name} host template ${value} has a label that can't be part of a hostname.`;
    }
  }
  if (new Set([resolved.web, resolved.cloud, resolved.site]).size < 3) {
    return `The web, cloud and site host templates must all differ.`;
  }
  return undefined;
};

export const assertHostTemplate = Effect.fn(function* (template?: HostTemplate) {
  const problem = hostTemplateProblem(template);
  if (problem !== undefined) return yield* new InvalidHostTemplate({ message: problem });
});

/**
 * Hostnames for a stage, from the platform's host template: by default
 * `<stage>.cloud.<domain>` for the Convex API and `<stage>.site.<domain>` for
 * HTTP actions. The production backend takes the bare `cloud.<domain>` and
 * `site.<domain>`. The stage sits in the leftmost label, so the platform's
 * certificate covers every stage and a new stage never waits for one.
 */
export const stageHosts = (
  domain: string,
  stage: string,
  isProd: boolean,
  options: { hosts?: HostTemplate; app?: string } = {},
) => {
  if (isProd) return { web: domain, cloud: `cloud.${domain}`, site: `site.${domain}` };
  const template = resolveHostTemplate(options.hosts);
  const values = { stage, app: options.app ?? "", domain };
  return {
    web: fill(template.web, values),
    cloud: fill(template.cloud, values),
    site: fill(template.site, values),
  };
};

/** `*.` in place of a template's first label. */
const wildcardOf = (template: string, domain: string) =>
  ["*", ...template.slice(0, -".{domain}".length).split(".").slice(1), domain].join(".");

/**
 * The names the platform's certificate covers: the domain, `*.<domain>` for the
 * production hosts, and a wildcard for each stage host template.
 */
export const certificateNames = (domain: string, template?: HostTemplate) => {
  const resolved = resolveHostTemplate(template);
  return {
    domainName: domain,
    subjectAlternativeNames: [
      ...new Set([
        `*.${domain}`,
        wildcardOf(resolved.cloud, domain),
        wildcardOf(resolved.site, domain),
      ]),
    ],
  };
};

/** Whether a certificate name covers a host. A wildcard covers exactly one label. */
export const certificateCovers = (name: string, host: string) => {
  if (!name.startsWith("*.")) return name === host;
  const dot = host.indexOf(".");
  return dot > 0 && host.slice(dot + 1) === name.slice(2);
};

export interface BackendHostOptions {
  /** The stage as a hostname label. */
  stage: string;
  production: boolean;
  /** Fills `{app}`. */
  app?: string;
  /** Hosts the stage picked itself, instead of the template's. */
  hosts?: { cloud: string; site: string };
}

/**
 * What's wrong with the hosts a backend on a platform would take, or
 * `undefined` when the platform's certificate and listener can serve them.
 */
export const backendHostsProblem = (
  domain: string,
  template: HostTemplate | undefined,
  options: BackendHostOptions,
): string | undefined => {
  const resolved = resolveHostTemplate(template);
  const usesApp = resolved.cloud.includes("{app}") || resolved.site.includes("{app}");
  if (options.hosts === undefined && !options.production) {
    if (usesApp && options.app === undefined) {
      return `The platform's host template uses {app}, so set app on the backend.`;
    }
    if (!usesApp && options.app !== undefined) {
      return `app only names hosts when the platform's host template uses {app}. Add {app} to the platform's hosts, or remove app.`;
    }
    if (options.app !== undefined && !LABEL.test(options.app)) {
      return `app ${options.app} must fit in a hostname: lowercase letters, digits and hyphens.`;
    }
  }
  const hosts = backendHostsOf(domain, template, options);
  for (const host of [hosts.cloud, hosts.site]) {
    if (host.split(".").some((label) => !LABEL.test(label) || label.length > 63)) {
      return `${host} isn't a valid hostname: each label holds lowercase letters, digits and hyphens, at most 63 characters.`;
    }
  }
  if (hosts.cloud === hosts.site) return `The cloud and site hosts must differ.`;
  const names = certificateNames(domain, template);
  const covered = [names.domainName, ...names.subjectAlternativeNames];
  for (const host of [hosts.cloud, hosts.site]) {
    if (!covered.some((name) => certificateCovers(name, host))) {
      return `The platform's certificate doesn't cover ${host}. It covers ${covered.join(", ")}.`;
    }
  }
  if (!options.production) {
    const production = stageHosts(domain, options.stage, true);
    for (const host of [hosts.cloud, hosts.site]) {
      if (host === production.cloud || host === production.site) {
        return `${host} is the production backend's host, so a stage can't take it.`;
      }
    }
  }
  return undefined;
};

const backendHostsOf = (
  domain: string,
  template: HostTemplate | undefined,
  options: BackendHostOptions,
) =>
  options.hosts ??
  stageHosts(domain, options.stage, options.production, { hosts: template, app: options.app });

/**
 * The two hosts a backend on a platform takes. Runs inside an Output, so a
 * problem throws the typed error rather than failing an Effect.
 */
export const backendHosts = (
  domain: string,
  template: HostTemplate | undefined,
  options: BackendHostOptions,
) => {
  const problem = backendHostsProblem(domain, template, options);
  if (problem !== undefined) throw new InvalidHosts({ message: problem });
  const { cloud, site } = backendHostsOf(domain, template, options);
  return { cloud, site };
};

/**
 * A stage's name as a hostname label: lowercase, with anything else turned into
 * hyphens, the same way the instance name is made. `dev_sam` becomes `dev-sam`.
 */
export const hostLabelOf = (stage: string) =>
  stage
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const assertStageHosts = Effect.fn(function* (stage: string) {
  if (stage.length > MAX_STAGE_LENGTH || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(stage)) {
    return yield* new InvalidStageName({
      message: `Stage ${stage} must fit in a hostname: lowercase letters, digits and hyphens, at most ${MAX_STAGE_LENGTH} characters.`,
    });
  }
  if (RESERVED_STAGE_LABELS.includes(stage)) {
    return yield* new InvalidStageName({
      message: `Stage ${stage} would claim the production backend's host, so it can't be named ${RESERVED_STAGE_LABELS.join(" or ")}.`,
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
