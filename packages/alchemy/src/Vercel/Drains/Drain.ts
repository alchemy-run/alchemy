/**
 * Vercel Drain resource — the unified observability drains API (`/v1/drains`).
 *
 * NOTE: the legacy Log Drains API (distilled service `log_drains`,
 * `/v1/integrations/log-drains` + `/v2/deployments/.../log-drains`) is
 * superseded by this unified drains API and is deliberately NOT implemented
 * as an alchemy resource — it is integration-scoped, redundant with `Drain`,
 * and Vercel steers all self-served use to `/v1/drains`.
 */
import * as drains from "@distilled.cloud/vercel/drains";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";

/**
 * Observability datasets a drain can subscribe to. Each key maps to a schema
 * version (currently `"v1"` for all datasets).
 */
export type DrainSchemaKey =
  | "log"
  | "trace"
  | "analytics"
  | "speed_insights"
  | "ai_gateway"
  | "audit_log"
  | "connect";

/**
 * The datasets the drain receives, keyed by dataset name with the schema
 * version to deliver, e.g. `{ log: { version: "v1" } }`.
 */
export type DrainSchemas = {
  [K in DrainSchemaKey]?: { version: string };
};

export type DrainLogSource =
  | "build"
  | "edge"
  | "lambda"
  | "static"
  | "external"
  | "firewall"
  | "redirect";

export type DrainEnvironment = "production" | "preview";

/**
 * Structured filter: restrict by project ids, log sources, and/or deployment
 * environments.
 */
export interface DrainBasicFilter {
  type: "basic";
  /** Restrict to specific project ids. */
  project?: { ids?: string[] };
  /** Restrict log events to specific sources. */
  log?: { sources?: DrainLogSource[] };
  /** Restrict to deployments in specific environments. */
  deployment?: { environments?: DrainEnvironment[] };
}

/** Free-form OData filter expression. */
export interface DrainODataFilter {
  type: "odata";
  text: string;
}

export type DrainFilter = DrainBasicFilter | DrainODataFilter;

/**
 * HTTP delivery — Vercel POSTs event batches to `endpoint`.
 *
 * Note: Vercel validates the endpoint URL at create time (unresolvable
 * hosts are rejected with a typed `BadRequest` "Invalid delivery endpoint"),
 * but does NOT verify delivery — the endpoint doesn't need to accept the
 * payloads for the drain to be created.
 */
export interface DrainHttpDelivery {
  type: "http";
  /** URL that receives the drained events. */
  endpoint: string;
  /** Payload encoding. */
  encoding: "json" | "ndjson";
  /**
   * Payload compression.
   * @default "none"
   */
  compression?: "gzip" | "none";
  /** Extra headers sent with every delivery request. */
  headers?: Record<string, string>;
  /**
   * Secret used to sign deliveries (`x-vercel-signature`). Write-only on
   * the Vercel side.
   */
  secret?: string;
}

/** OTLP/HTTP delivery for traces. */
export interface DrainOtlpDelivery {
  type: "otlphttp";
  /** Per-signal OTLP endpoints. */
  endpoint: { traces: string };
  /** OTLP encoding. */
  encoding: "proto" | "json";
  /** Extra headers sent with every delivery request. */
  headers?: Record<string, string>;
  /** Secret used to sign deliveries. Write-only on the Vercel side. */
  secret?: string;
}

/** S3-compatible bucket delivery (AWS role-based). */
export interface DrainS3Delivery {
  type: "s3";
  /** Bucket URL, e.g. `s3://my-bucket/prefix`. */
  endpoint: string;
  encoding: "json" | "ndjson";
  compression: "none";
  fileStructure: "hive";
  /** IAM role Vercel assumes to write objects. */
  roleArn: string;
  /** Bucket region. */
  region: string;
  serverSideEncryption?: "AES256" | "aws:kms" | "aws:kms:dsse";
  objectAcl?: "private" | "bucket-owner-read" | "bucket-owner-full-control";
}

export type DrainDelivery =
  | DrainHttpDelivery
  | DrainOtlpDelivery
  | DrainS3Delivery;

/** Head-sampling rule applied before delivery. */
export interface DrainSamplingRule {
  /** Sampling rate from 0 to 1 (e.g. 0.1 for 10%). */
  rate: number;
  /** Environment to apply sampling to. */
  env?: DrainEnvironment;
  /** Request path prefix to apply the sampling rule to. */
  requestPath?: string;
}

export type DrainStatus = "enabled" | "disabled" | "errored";

export interface DrainProps {
  /**
   * Name of the drain. If omitted, a unique name is generated from
   * `${app}-${id}-${stage}`.
   */
  name?: string;
  /**
   * Whether the drain receives events from all projects or only the
   * projects listed in `projectIds`.
   *
   * @default "all"
   */
  projects?: "all" | "some";
  /**
   * Project ids to drain when `projects` is `"some"`.
   */
  projectIds?: string[];
  /**
   * Filter applied to events before delivery. Omit for no filtering
   * (equivalent to an empty `basic` filter).
   */
  filter?: DrainFilter;
  /**
   * The datasets to drain, keyed by dataset with schema version, e.g.
   * `{ log: { version: "v1" } }`.
   */
  schemas: DrainSchemas;
  /**
   * Where and how events are delivered.
   */
  delivery: DrainDelivery;
  /**
   * Head-sampling rules. Omit to deliver everything.
   */
  sampling?: DrainSamplingRule[];
  /**
   * Transforms applied before delivery, referenced by id. Not readable back
   * from the API, so drift in this field is detected against the last
   * deployed props rather than observed cloud state.
   */
  transforms?: { id: string }[];
  /**
   * Desired status. Use `"disabled"` to pause delivery without deleting
   * the drain.
   *
   * @default "enabled"
   */
  status?: "enabled" | "disabled";
}

export type Drain = Resource<
  "Vercel.Drain",
  DrainProps,
  {
    /** Drain id, e.g. `drn_xxxxxxxx`. */
    drainId: string;
    /** Drain name. */
    drainName: string;
    /** Current status. `errored` is set by Vercel after delivery failures. */
    status: DrainStatus;
    /** Creation timestamp (epoch ms). */
    createdAt: number;
    /** Last-update timestamp (epoch ms). */
    updatedAt: number;
    /** Owning user or team id. */
    ownerId: string;
    /** Team id, when team-scoped. */
    teamId: string | undefined;
    /** Project ids the drain is restricted to (absent = all projects). */
    projectIds: string[] | undefined;
  },
  never,
  Providers
>;

type DrainAttributes = Drain["Attributes"];

/**
 * A Vercel observability Drain — streams logs, traces, analytics, and other
 * datasets to an external endpoint over the unified `/v1/drains` API.
 *
 * @resource
 * @section Creating a Drain
 * @example Drain all project logs to an HTTP endpoint
 * ```typescript
 * const drain = yield* Vercel.Drain("Logs", {
 *   schemas: { log: { version: "v1" } },
 *   delivery: {
 *     type: "http",
 *     endpoint: "https://logs.example.com/ingest",
 *     encoding: "ndjson",
 *     compression: "gzip",
 *     headers: { authorization: "Bearer abc" },
 *   },
 * });
 * ```
 *
 * @example Drain traces over OTLP
 * ```typescript
 * const drain = yield* Vercel.Drain("Traces", {
 *   schemas: { trace: { version: "v1" } },
 *   delivery: {
 *     type: "otlphttp",
 *     endpoint: { traces: "https://otel.example.com/v1/traces" },
 *     encoding: "proto",
 *   },
 * });
 * ```
 *
 * @section Filtering and sampling
 * @example Only lambda logs from production deployments
 * ```typescript
 * const drain = yield* Vercel.Drain("ProdLambdaLogs", {
 *   schemas: { log: { version: "v1" } },
 *   filter: {
 *     type: "basic",
 *     log: { sources: ["lambda"] },
 *     deployment: { environments: ["production"] },
 *   },
 *   delivery: {
 *     type: "http",
 *     endpoint: "https://logs.example.com/ingest",
 *     encoding: "json",
 *   },
 * });
 * ```
 *
 * @example Sample 10% of production events
 * ```typescript
 * const drain = yield* Vercel.Drain("Sampled", {
 *   schemas: { log: { version: "v1" } },
 *   sampling: [{ rate: 0.1, env: "production" }],
 *   delivery: {
 *     type: "http",
 *     endpoint: "https://logs.example.com/ingest",
 *     encoding: "json",
 *   },
 * });
 * ```
 *
 * @section Scoping to specific projects
 * @example Drain only two projects
 * ```typescript
 * const drain = yield* Vercel.Drain("AppLogs", {
 *   projects: "some",
 *   projectIds: [projectA.projectId, projectB.projectId],
 *   schemas: { log: { version: "v1" } },
 *   delivery: {
 *     type: "http",
 *     endpoint: "https://logs.example.com/ingest",
 *     encoding: "json",
 *   },
 * });
 * ```
 *
 * @see https://vercel.com/docs/drains
 */
export const Drain = Resource<Drain>("Vercel.Drain");

export const DrainProvider = () =>
  Provider.succeed(Drain, {
    stables: ["drainId", "ownerId", "createdAt"],
    // NOTE on the `testDrain` op (`POST /v1/drains/test`): it delivers sample
    // events to the configured endpoint — a side effect — so it is NOT used
    // as plan-time validation in `diff`. Endpoint validation happens at
    // create/update time via Vercel's own typed `BadRequest` rejection.
    list: Effect.fn(function* () {
      const { teamId } = yield* VercelEnvironment.current;
      const response = yield* drains.getDrains({ teamId });
      const rows: DrainAttributes[] = [];
      for (const d of response.drains) {
        // Integration-sourced drains are owned by marketplace integrations
        // and can never have been created by this provider — skip them so
        // account-wide teardown never tears down an integration's drain.
        if (d.source.kind !== "self-served") continue;
        rows.push(toAttributes(d));
      }
      return rows;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const { teamId } = yield* VercelEnvironment.current;
      if (output?.drainId) {
        return yield* drains.getDrain({ id: output.drainId, teamId }).pipe(
          Effect.map(toAttributes),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      }
      // Persistence-failure path: drains have no env/metadata surface to
      // stamp ownership on (§5.4), so ownership = deterministic naming.
      // Auto-generated names embed app/stage/id + instance suffix and can't
      // collide with foreign drains; an explicit user name is only matched
      // when it was recorded in `olds`.
      const name = olds?.name ?? (yield* createPhysicalName({ id }));
      const response = yield* drains.getDrains({ teamId });
      for (const d of response.drains) {
        if (d.source.kind === "self-served" && d.name === name) {
          return toAttributes(d);
        }
      }
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { teamId } = yield* VercelEnvironment.current;

      // Observe — output.drainId is a cache, not a guarantee: fall through
      // to create when the drain no longer exists.
      const observed = output?.drainId
        ? yield* drains
            .getDrain({ id: output.drainId, teamId })
            .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)))
        : undefined;

      const desiredName =
        news.name ?? output?.drainName ?? (yield* createPhysicalName({ id }));
      const desiredProjects = news.projects ?? "all";
      const desiredProjectIds =
        desiredProjects === "some" ? (news.projectIds ?? []) : undefined;
      const desiredFilter: DrainFilter = news.filter ?? { type: "basic" };
      const desiredDelivery = toWireDelivery(news.delivery);
      const desiredSampling = news.sampling?.map((rule) => ({
        type: "head_sampling",
        rate: rule.rate,
        env: rule.env,
        requestPath: rule.requestPath,
      }));
      const desiredStatus = news.status ?? "enabled";

      // Ensure — greenfield (or vanished) drain.
      if (observed === undefined) {
        const created = yield* drains.createDrain({
          teamId,
          name: desiredName,
          projects: desiredProjects,
          projectIds: desiredProjectIds,
          filter: news.filter
            ? { version: "v2", filter: news.filter }
            : undefined,
          schemas: news.schemas,
          delivery: desiredDelivery,
          sampling: desiredSampling,
          transforms: news.transforms,
        });
        return toAttributes(created);
      }

      // Sync — diff each observed aspect against desired; PATCH only deltas.
      const patch: {
        name?: string;
        projects?: "all" | "some";
        projectIds?: string[] | null;
        filter?: { version: string; filter: DrainFilter };
        schemas?: DrainSchemas;
        delivery?: drains.CreateDrainRequestDelivery;
        sampling?: typeof desiredSampling | null;
        transforms?: { id: string }[] | null;
        status?: "enabled" | "disabled";
      } = {};

      if (observed.name !== desiredName) {
        patch.name = desiredName;
      }

      const observedProjectIds = [...(observed.projectIds ?? [])].sort();
      if (desiredProjects === "all") {
        if (observedProjectIds.length > 0) {
          patch.projects = "all";
          patch.projectIds = null;
        }
      } else if (
        canonical([...(desiredProjectIds ?? [])].sort()) !==
        canonical(observedProjectIds)
      ) {
        patch.projects = "some";
        patch.projectIds = desiredProjectIds ?? [];
      }

      if (canonical(news.schemas) !== canonical(observed.schemas)) {
        patch.schemas = news.schemas;
      }

      // Delivery: compare without `secret` (write-only on Vercel's side) and
      // fall back to the previous props as a hint for secret rotation.
      if (
        canonical(omitKeys(desiredDelivery, ["secret"])) !==
          canonical(omitKeys(observed.delivery, ["secret"])) ||
        deliverySecret(news.delivery) !== deliverySecret(olds?.delivery)
      ) {
        patch.delivery = desiredDelivery;
      }

      // Filter: "no filter" is canonically an empty basic filter so that a
      // removed `filter:` prop converges instead of re-patching forever.
      // Vercel decorates observed basic filters with a legacy field — strip
      // it before comparing.
      const observedFilter = omitKeys(observed.filterV2?.filter, [
        "legacy_excludeCachedStaticAssetLogs",
      ]) ?? { type: "basic" };
      if (canonical(desiredFilter) !== canonical(observedFilter)) {
        patch.filter = { version: "v2", filter: desiredFilter };
      }

      if (desiredSampling === undefined) {
        if ((observed.sampling?.length ?? 0) > 0) {
          patch.sampling = null;
        }
      } else if (canonical(desiredSampling) !== canonical(observed.sampling)) {
        patch.sampling = desiredSampling;
      }

      // Transforms are not readable back from the API — diff against the
      // last deployed props as a hint (the doctrine's one sanctioned use).
      if (canonical(news.transforms) !== canonical(olds?.transforms)) {
        patch.transforms = news.transforms ?? null;
      }

      if ((observed.status ?? "enabled") !== desiredStatus) {
        patch.status = desiredStatus;
      }

      if (Object.keys(patch).length === 0) {
        return toAttributes(observed);
      }

      const updated = yield* drains.updateDrain({
        id: observed.id,
        teamId,
        ...patch,
      });
      return toAttributes(updated);
    }),
    delete: Effect.fn(function* ({ output }) {
      const { teamId } = yield* VercelEnvironment.current;
      yield* drains
        .deleteDrain({ id: output.drainId, teamId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });

/**
 * Minimal structural shape shared by every drains API response variant
 * (create/get/update/list x self-served/integration).
 */
interface DrainApiShape {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly ownerId: string;
  readonly teamId?: string | null;
  readonly status?: DrainStatus;
  readonly projectIds?: ReadonlyArray<string>;
}

const toAttributes = (d: DrainApiShape): DrainAttributes => ({
  drainId: d.id,
  drainName: d.name,
  status: d.status ?? "enabled",
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
  ownerId: d.ownerId,
  teamId: d.teamId ?? undefined,
  projectIds: d.projectIds ? [...d.projectIds] : undefined,
});

/** Normalize the user-facing delivery into the wire shape (headers required). */
const toWireDelivery = (
  delivery: DrainDelivery,
): drains.CreateDrainRequestDelivery => {
  switch (delivery.type) {
    case "http":
      return { ...delivery, headers: delivery.headers ?? {} };
    case "otlphttp":
      return { ...delivery, headers: delivery.headers ?? {} };
    case "s3":
      return delivery;
  }
};

const deliverySecret = (
  delivery: DrainDelivery | undefined,
): string | undefined =>
  delivery !== undefined && delivery.type !== "s3"
    ? delivery.secret
    : undefined;

/**
 * Canonical JSON for config comparison: recursively sorts object keys and
 * drops `undefined` members so `{a: undefined}` ≡ `{}` and key order never
 * produces a phantom diff.
 */
const canonical = (value: unknown): string =>
  JSON.stringify(sortValue(value)) ?? "undefined";

const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) out[key] = sortValue(record[key]);
    }
    return out;
  }
  return value;
};

/** Shallow-copy an object dropping the given keys (undefined stays undefined). */
const omitKeys = (
  value: unknown,
  keys: ReadonlyArray<string>,
): Record<string, unknown> | undefined => {
  if (value === null || value === undefined || typeof value !== "object") {
    return undefined;
  }
  const out: Record<string, unknown> = {
    ...(value as Record<string, unknown>),
  };
  for (const key of keys) delete out[key];
  return out;
};
