import { createHash } from "node:crypto";
import * as service from "@distilled.cloud/clickhouse-cloud/service";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { ScopedPlanStatusSession } from "alchemy/Report";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import {
  requireResult,
  ResultMissing,
  ServiceDeletionProtected,
  ServiceLimitReached,
} from "../Errors.ts";
import {
  hasOwnerTags,
  INSTANCE_TAG,
  isAlchemyTagged,
  ownerTags,
  serviceName,
} from "../internal/Names.ts";
import {
  getLiveService,
  isGone,
  isRunning,
  waitForService,
  waitUntilServiceGone,
} from "../internal/Wait.ts";
import type { Providers } from "../Providers.ts";

/** A cloud provider a service runs on. */
export type CloudProvider = "aws" | "gcp" | "azure";

/** A region a service runs in, e.g. `us-east-1` (AWS), `us-central1` (GCP), `eastus2` (Azure). */
export type Region = service.CreateServiceRequestRegion | (string & {});

/** One allowed source of connections to the service. */
export interface IpAccessEntry {
  /** An IPv4 address or CIDR, e.g. `203.0.113.7` or `0.0.0.0/0`. */
  source: string;
  /** What the entry is for. */
  description?: string;
}

/** An optional endpoint to switch on or off. */
export interface EndpointToggle {
  /** Endpoint protocol. Only the MySQL interface can be toggled. */
  protocol: "mysql";
  /** Whether the endpoint is enabled. */
  enabled: boolean;
}

/** One endpoint the service listens on. */
export interface ServiceEndpoint {
  /** `https` (HTTP interface), `nativesecure` (native protocol over TLS) or `mysql`. */
  protocol: "https" | "nativesecure" | "mysql";
  /** Host name. */
  host: string;
  /** Port. */
  port: number;
  /** User name for the endpoint, when it has its own. */
  username: string | undefined;
}

export interface ServiceProps {
  /**
   * Service name: letters, digits and spaces, up to 50 characters. If
   * omitted, a unique name is generated from the stack, stage and logical
   * ID. Changing it renames the service in place.
   */
  name?: string;
  /**
   * Cloud provider the service runs on. Changing it replaces the service,
   * which discards its data.
   */
  provider: CloudProvider;
  /**
   * Region the service runs in. Changing it replaces the service, which
   * discards its data.
   */
  region: Region;
  /**
   * Addresses allowed to connect to the service. Alchemy converges the
   * service's list to exactly these entries. An empty list allows no one.
   * @default []
   */
  ipAccessList?: IpAccessEntry[];
  /**
   * Desired state. `"stopped"` stops the service (storage is kept, compute
   * is not billed); `"running"` starts it. A running service that idle
   * scaling has scaled to zero (`idle`) counts as running: alchemy never
   * wakes it.
   * @default "running"
   */
  state?: "running" | "stopped";
  /**
   * Minimum memory of each replica in GB while autoscaling: a multiple of
   * 4, at least 8.
   */
  minReplicaMemoryGb?: number;
  /**
   * Maximum memory of each replica in GB while autoscaling: a multiple of
   * 4, at most 120 (unpaid) or 356 (paid organizations).
   */
  maxReplicaMemoryGb?: number;
  /**
   * Fixed number of replicas (1-50) for vertical autoscaling. Mutually
   * exclusive with `minReplicas` / `maxReplicas`.
   */
  numReplicas?: number;
  /**
   * `"vertical"` scales memory at a fixed replica count; `"horizontal"`
   * scales the replica count at a fixed memory per replica (needs the
   * feature enabled for the organization).
   * @default "vertical"
   */
  autoscalingMode?: "vertical" | "horizontal";
  /** Minimum replicas for horizontal autoscaling; set with `maxReplicas`. */
  minReplicas?: number;
  /** Maximum replicas for horizontal autoscaling; set with `minReplicas`. */
  maxReplicas?: number;
  /**
   * Whether the service scales to zero when idle.
   * @default true
   */
  idleScaling?: boolean;
  /** Minutes of inactivity before an idle service scales to zero; at least 5. */
  idleTimeoutMinutes?: number;
  /**
   * Instance profile, e.g. `"v1-default"` or `"v2-default"` (Gen 2).
   * Profiles other than these two need an ENTERPRISE or BYOC organization.
   */
  profile?: string;
  /**
   * Release channel: `"fast"` gets new ClickHouse releases first, `"slow"`
   * defers them. Shared by every service in the warehouse.
   * @default "default"
   */
  releaseChannel?: "slow" | "default" | "fast";
  /** Optional endpoints to enable or disable (the MySQL interface). */
  endpoints?: EndpointToggle[];
  /**
   * Tags on the service. Keys and values hold letters, digits, `-`, `_`
   * and `.`. Alchemy adds its `alchemy.stack`, `alchemy.stage`,
   * `alchemy.id` and `alchemy.instance` ownership tags; a user tag never
   * overwrites them.
   */
  tags?: Record<string, string>;
  /** Whether the underlying infrastructure collects core dumps. */
  enableCoreDumps?: boolean;
  /**
   * When true, the service cannot be deleted: destroy fails until it is
   * turned off. Turning it on needs deletion protection enabled for the
   * organization.
   * @default false
   */
  deletionProtection?: boolean;
  /** ID of the transparent data encryption key to rotate to (TDE services only). */
  transparentDataEncryptionKeyId?: string;
  /**
   * Enables transparent data encryption (ENTERPRISE). Only set at creation:
   * changing it replaces the service.
   */
  hasTransparentDataEncryption?: boolean;
  /** Regulatory compliance type. Changing it replaces the service. */
  complianceType?: "hipaa" | "pci";
  /**
   * Data warehouse to join as a secondary (compute-compute) service: the
   * `dataWarehouseId` of a primary service. Changing it replaces the
   * service.
   */
  dataWarehouseId?: string;
  /**
   * Whether this secondary service is read-only. Needs `dataWarehouseId`.
   * Changing it replaces the service.
   */
  isReadonly?: boolean;
  /**
   * BYOC infrastructure to run on. Needs `minReplicaMemoryGb` and
   * `maxReplicaMemoryGb`. Changing it replaces the service.
   */
  byocId?: string;
  /**
   * Backup to restore as the new service's initial data. Only read at
   * creation: changing it replaces the service, which discards the data
   * of the old one.
   */
  backupId?: string;
  /**
   * The `encryption_config.json` stored with a backup in your own bucket,
   * verbatim. Required with `backupId` when the backup lives in your
   * bucket. Changing it replaces the service.
   */
  backupEncryptionConfig?: Record<string, unknown>;
  /**
   * Password of the `default` user. Write-only: alchemy sends only its
   * SHA-256 and double SHA-1 hashes, and changes the password when the
   * value changes. If omitted, the service keeps the password ClickHouse
   * generated at creation (the `password` attribute).
   */
  password?: Redacted.Redacted<string>;
  /**
   * Replica-aware routing for HTTP and native connections (an
   * organization feature). Omit to leave the setting alone.
   */
  replicaAwareRouting?: { http?: boolean; native?: boolean };
  /**
   * Accept the private preview terms. Only needed for the first service
   * of an organization in a private preview; never compared after
   * creation.
   */
  privatePreviewTermsChecked?: boolean;
}

export interface ServiceAttributes {
  /** Service ID. */
  serviceId: string;
  /** Organization that owns the service. */
  organizationId: string;
  /** Service name. */
  name: string;
  /** Cloud provider. */
  provider: service.Service["provider"];
  /** Region. */
  region: service.Service["region"];
  /**
   * Runtime state: `running`, `idle` (scaled to zero), `stopped`,
   * `provisioning`, `starting`, `stopping`, `awaking`, `degraded`, ….
   */
  state: service.ServiceState | undefined;
  /** ClickHouse version. */
  clickhouseVersion: string | undefined;
  /** Every endpoint the service listens on. */
  endpoints: ServiceEndpoint[];
  /** Host of the HTTPS interface. */
  host: string | undefined;
  /** HTTPS interface URL, `https://<host>:8443`. */
  httpsUrl: string | undefined;
  /** User the generated password belongs to. */
  username: string;
  /**
   * Password of the `default` user: the `password` prop when set, otherwise
   * the password ClickHouse generated at creation (returned only once, so
   * alchemy keeps it in state).
   */
  password: Redacted.Redacted<string> | undefined;
  /** SHA-256 of the last `password` prop alchemy applied. */
  passwordDigest: Redacted.Redacted<string> | undefined;
  /** Allowed sources of connections. */
  ipAccessList: IpAccessEntry[];
  /** Tags on the service, including alchemy's ownership tags. */
  tags: Record<string, string>;
  /** Configured autoscaling mode. */
  autoscalingMode: service.Service["autoscalingMode"];
  /** Minimum memory per replica in GB. */
  minReplicaMemoryGb: number | undefined;
  /** Maximum memory per replica in GB. */
  maxReplicaMemoryGb: number | undefined;
  /** Fixed replica count (vertical autoscaling). */
  numReplicas: number | undefined;
  /** Minimum replicas (horizontal autoscaling). */
  minReplicas: number | undefined;
  /** Maximum replicas (horizontal autoscaling). */
  maxReplicas: number | undefined;
  /** Whether idle scaling is on. */
  idleScaling: boolean | undefined;
  /** Idle timeout in minutes. */
  idleTimeoutMinutes: number | undefined;
  /** Instance profile. */
  profile: string | undefined;
  /** Release channel. */
  releaseChannel: service.Service["releaseChannel"];
  /** Whether deletion protection is on. */
  deletionProtection: boolean;
  /** Whether core dumps are collected. */
  enableCoreDumps: boolean | undefined;
  /** Data warehouse the service belongs to. */
  dataWarehouseId: string | undefined;
  /** Whether this is the primary service of its warehouse. */
  isPrimary: boolean | undefined;
  /** Whether this service is read-only. */
  isReadonly: boolean | undefined;
  /** IAM role the service uses to read S3 objects. */
  iamRole: string | undefined;
  /** Private endpoints attached to the service. */
  privateEndpointIds: string[];
  /** Replica-aware routing, when managed. */
  replicaAwareRouting: { http: boolean | undefined; native: boolean | undefined } | undefined;
  /** When the service was created (ISO 8601). */
  createdAt: string | undefined;
}

export type Service = Resource<
  "ClickHouseCloud.Service.Service",
  ServiceProps,
  ServiceAttributes,
  never,
  Providers
>;

/**
 * A ClickHouse Cloud service: compute and storage for a ClickHouse
 * database, reachable over HTTPS, the native protocol and optionally
 * MySQL.
 *
 * Creating a service takes about a minute: deploy returns once the
 * service is `running`. ClickHouse generates a password for the `default` user and
 * returns it once; alchemy keeps it in state as the `password` attribute.
 * Replacing a service (changing `provider`, `region`, or another
 * creation-only prop) deletes the old service with its data first, then
 * creates a new, empty one, so the stack has no service for a few minutes.
 *
 * Alchemy stops a service before deleting it, as the API requires;
 * stopping takes two to three minutes, and the service is gone right after
 * the delete call. A service with `deletionProtection` on is never deleted:
 * destroy fails with `ServiceDeletionProtected` until protection is turned
 * off. Creating a service when the organization already has as many as
 * its plan allows fails with `ServiceLimitReached`.
 * @see https://clickhouse.com/docs/cloud/manage/openapi
 *
 * ### Creating a Service
 * **Example:** A small AWS service that idles when unused
 * ```typescript
 * const analytics = yield* ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0", description: "anywhere" }],
 *   minReplicaMemoryGb: 8,
 *   maxReplicaMemoryGb: 8,
 *   numReplicas: 1,
 *   idleScaling: true,
 *   idleTimeoutMinutes: 5,
 * });
 * ```
 *
 * **Example:** A GCP service with tags
 * ```typescript
 * const events = yield* ClickHouseCloud.Service.Service("Events", {
 *   provider: "gcp",
 *   region: "us-central1",
 *   ipAccessList: [{ source: "203.0.113.0/24", description: "office" }],
 *   tags: { team: "data", env: "prod" },
 * });
 * ```
 *
 * ### Connecting
 * **Example:** The HTTPS URL and the default user's password
 * ```typescript
 * const analytics = yield* ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 * });
 * // analytics.httpsUrl  -> https://<host>:8443
 * // analytics.username  -> "default"
 * // analytics.password  -> Redacted, generated once by ClickHouse
 * ```
 *
 * **Example:** Set the password yourself
 * ```typescript
 * const analytics = yield* ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 *   password: yield* Config.redacted("CLICKHOUSE_PASSWORD"),
 * });
 * ```
 *
 * ### Network Access
 * **Example:** Allow only your office and CI
 * ```typescript
 * const analytics = yield* ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "eu-west-1",
 *   ipAccessList: [
 *     { source: "203.0.113.0/24", description: "office" },
 *     { source: "198.51.100.7", description: "ci" },
 *   ],
 *   endpoints: [{ protocol: "mysql", enabled: true }],
 * });
 * ```
 *
 * ### Scaling and Idling
 * **Example:** Three replicas that scale between 16 and 64 GB each
 * ```typescript
 * const warehouse = yield* ClickHouseCloud.Service.Service("Warehouse", {
 *   provider: "aws",
 *   region: "us-east-2",
 *   ipAccessList: [{ source: "10.0.0.0/8" }],
 *   numReplicas: 3,
 *   minReplicaMemoryGb: 16,
 *   maxReplicaMemoryGb: 64,
 *   idleScaling: false,
 * });
 * ```
 *
 * **Example:** Stop a service you don't need right now
 * ```typescript
 * const staging = yield* ClickHouseCloud.Service.Service("Staging", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 *   state: "stopped",
 * });
 * ```
 *
 * ### Deletion Protection
 * **Example:** Refuse to delete production
 * ```typescript
 * const production = yield* ClickHouseCloud.Service.Service("Production", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "10.0.0.0/8" }],
 *   deletionProtection: true,
 * });
 * ```
 *
 * ### Backups
 * **Example:** Back up every 12 hours, keep backups for a week
 * ```typescript
 * const analytics = yield* ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 * });
 * yield* ClickHouseCloud.Backup.BackupConfiguration("AnalyticsBackups", {
 *   serviceId: analytics.serviceId,
 *   backupPeriodInHours: 12,
 *   backupRetentionPeriodInHours: 168,
 * });
 * ```
 *
 * **Example:** Restore a backup into a new service
 * ```typescript
 * const restored = yield* ClickHouseCloud.Service.Service("Restored", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 *   backupId: "<backup id from ClickHouseCloud.Backup.ListBackups>",
 * });
 * ```
 *
 * ### Binding to a Runtime
 * **Example:** Read the service's state from a Worker
 * ```typescript
 * export const Analytics = ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const getService = yield* ClickHouseCloud.Service.GetService(Analytics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const svc = yield* getService();
 *         return yield* HttpServerResponse.json({ state: svc.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Service.GetServiceHttp)),
 * ) {}
 * ```
 *
 * ### Runtime Operations
 * **Example:** Wake an idle service before a burst of queries
 * ```typescript
 * // init, inside the Worker above, with UpdateServiceStateHttp provided
 * const updateState = yield* ClickHouseCloud.Service.UpdateServiceState(Analytics);
 * // runtime
 * yield* updateState("awake");
 * ```
 *
 * @resource
 * @product Service
 */
export const Service = Resource<Service>("ClickHouseCloud.Service.Service");

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/** base64(SHA-256(password)): the `newPasswordHash` the API takes. */
const passwordHash = (password: string) => sha256(password).toString("base64");

/** hex(SHA-1(SHA-1(password))): the MySQL `newDoubleSha1Hash` the API takes. */
const doubleSha1Hash = (password: string) =>
  createHash("sha1").update(createHash("sha1").update(password).digest()).digest("hex");

const passwordDigestOf = (password: Redacted.Redacted<string>) =>
  password.pipe(Redacted.value, sha256, (digest) => Redacted.make(digest.toString("hex")));

const tagRecord = (tags: service.ResourceTagsV1[] | undefined) =>
  Object.fromEntries((tags ?? []).map((tag) => [tag.key, tag.value ?? ""]));

const toEndpoints = (endpoints: service.ServiceEndpoint[] | undefined): ServiceEndpoint[] =>
  (endpoints ?? []).flatMap((e) =>
    e.protocol !== undefined && e.host !== undefined && e.port !== undefined
      ? [{ protocol: e.protocol, host: e.host, port: e.port, username: e.username ?? undefined }]
      : [],
  );

const toAttributes = (
  organizationId: string,
  observed: service.Service,
  secrets: {
    password: Redacted.Redacted<string> | undefined;
    passwordDigest: Redacted.Redacted<string> | undefined;
  },
  replicaAwareRouting: ServiceAttributes["replicaAwareRouting"],
): ServiceAttributes => {
  const endpoints = toEndpoints(observed.endpoints);
  const https = endpoints.find((e) => e.protocol === "https");
  return {
    serviceId: observed.id ?? "",
    organizationId,
    name: observed.name ?? "",
    provider: observed.provider,
    region: observed.region,
    state: observed.state,
    clickhouseVersion: observed.clickhouseVersion,
    endpoints,
    host: https?.host,
    httpsUrl: https ? `https://${https.host}:${https.port}` : undefined,
    username: https?.username ?? "default",
    password: secrets.password,
    passwordDigest: secrets.passwordDigest,
    ipAccessList: (observed.ipAccessList ?? []).flatMap((entry) =>
      entry.source === undefined
        ? []
        : [
            entry.description === undefined
              ? { source: entry.source }
              : { source: entry.source, description: entry.description },
          ],
    ),
    tags: tagRecord(observed.tags),
    autoscalingMode: observed.autoscalingMode,
    minReplicaMemoryGb: observed.minReplicaMemoryGb,
    maxReplicaMemoryGb: observed.maxReplicaMemoryGb,
    numReplicas: observed.numReplicas,
    minReplicas: observed.minReplicas,
    maxReplicas: observed.maxReplicas,
    idleScaling: observed.idleScaling,
    idleTimeoutMinutes: observed.idleTimeoutMinutes,
    profile: observed.profile,
    releaseChannel: observed.releaseChannel,
    deletionProtection: observed.deletionProtection ?? false,
    enableCoreDumps: observed.enableCoreDumps,
    dataWarehouseId: observed.dataWarehouseId,
    isPrimary: observed.isPrimary,
    isReadonly: observed.isReadonly,
    iamRole: observed.iamRole,
    privateEndpointIds: observed.privateEndpointIds ?? [],
    replicaAwareRouting,
    createdAt: observed.createdAt,
  };
};

/** Props whose change needs a new service: the API only takes them at creation. */
const CREATE_ONLY = [
  "provider",
  "region",
  "hasTransparentDataEncryption",
  "complianceType",
  "dataWarehouseId",
  "isReadonly",
  "byocId",
  "backupId",
  "backupEncryptionConfig",
] as const satisfies ReadonlyArray<keyof ServiceProps>;

const sameEntry = (
  a: { source?: string | undefined; description?: string | undefined },
  b: { source?: string | undefined; description?: string | undefined },
) => a.source === b.source && (a.description ?? "") === (b.description ?? "");

/**
 * Find a service this generation of the logical ID created whose ID never
 * reached state. The instance tag tells generations apart: during a
 * replacement the service being replaced carries the same stack, stage
 * and logical ID.
 */
const findOwned = Effect.fn(function* (id: string, instanceId: string, organizationId: string) {
  const services = yield* service
    .listServices({ organizationId })
    .pipe(Effect.flatMap(requireResult("listServices")));
  for (const candidate of services) {
    if (candidate.id === undefined || isGone(candidate.state)) continue;
    const sameInstance = (candidate.tags ?? []).some(
      (tag) => tag.key === INSTANCE_TAG && tag.value === instanceId,
    );
    if (sameInstance && (yield* hasOwnerTags(id, candidate.tags))) return candidate;
  }
  return undefined;
});

const settle = Effect.fn(function* (
  organizationId: string,
  serviceId: string,
  session: ScopedPlanStatusSession,
) {
  return yield* waitForService({
    organizationId,
    serviceId,
    waitingFor: "running or stopped",
    done: (s) => isRunning(s.state) || s.state === "stopped",
    session,
  });
});

const setState = Effect.fn(function* (
  organizationId: string,
  serviceId: string,
  command: "start" | "stop",
  session: ScopedPlanStatusSession,
) {
  yield* session.note(command === "start" ? "Starting the service..." : "Stopping the service...");
  yield* service.updateServiceState({ organizationId, serviceId, command });
  return yield* waitForService({
    organizationId,
    serviceId,
    waitingFor: command === "start" ? "running" : "stopped",
    done: (s) => (command === "start" ? isRunning(s.state) : s.state === "stopped"),
    session,
  });
});

export const ServiceProvider = () =>
  Provider.effect(
    Service,
    Effect.gen(function* () {
      const readRouting = (organizationId: string, serviceId: string) =>
        service.getReplicaAwareRouting({ organizationId, serviceId }).pipe(
          Effect.flatMap(requireResult("getReplicaAwareRouting")),
          Effect.map((r) => ({ http: r.httpEnabled, native: r.nativeEnabled })),
        );

      return {
        stables: ["serviceId", "organizationId", "provider", "region", "createdAt"],
        nuke: { dependsOn: ["ClickHouseCloud.Organization.ByocInfrastructure"] },
        list: Effect.fn(function* () {
          const organizationId = yield* currentOrganizationId;
          const services = yield* service
            .listServices({ organizationId })
            .pipe(Effect.flatMap(requireResult("listServices")));
          return services
            .filter((s) => s.id !== undefined && !isGone(s.state) && isAlchemyTagged(s.tags))
            .map((s) =>
              toAttributes(
                organizationId,
                s,
                { password: undefined, passwordDigest: undefined },
                undefined,
              ),
            );
        }),
        diff: Effect.fn(function* ({ news, olds, output }) {
          if (!isResolved(news) || output === undefined || olds === undefined) return undefined;
          if (CREATE_ONLY.some((key) => !deepEqual(news[key], olds[key]))) {
            // The new service starts empty, so overlapping the two keeps no
            // data; it would bill both and need a second service slot, which
            // trial organizations don't have (`InstanceLimitReached`).
            return { action: "replace", deleteFirst: true } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ id, instanceId, olds, output }) {
          const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
          const secrets = {
            password: output?.password,
            passwordDigest: output?.passwordDigest,
          };
          if (output?.serviceId) {
            const observed = yield* getLiveService(organizationId, output.serviceId);
            return observed
              ? toAttributes(organizationId, observed, secrets, output.replicaAwareRouting)
              : undefined;
          }
          const owned = yield* findOwned(id, instanceId, organizationId);
          if (owned) return toAttributes(organizationId, owned, secrets, undefined);
          if (olds?.name === undefined) return undefined;
          // A service with the user's explicit name but without our tags
          // belongs to someone else: adopting it needs `--adopt`.
          const services = yield* service
            .listServices({ organizationId })
            .pipe(Effect.flatMap(requireResult("listServices")));
          const named = services.find((s) => s.name === olds.name && !isGone(s.state));
          // Another generation of this logical ID (the one a replacement
          // replaces) is not someone else's service, and not this one.
          if (named === undefined || (yield* hasOwnerTags(id, named.tags))) return undefined;
          return Unowned(toAttributes(organizationId, named, secrets, undefined));
        }),
        reconcile: Effect.fn(function* ({ id, instanceId, news, output, session }) {
          const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
          const name = news.name ?? output?.name ?? (yield* serviceName(id));
          const owner = yield* ownerTags(id);
          const desiredTags: Record<string, string> = {
            ...Object.fromEntries(
              Object.entries(news.tags ?? {}).filter(([key]) => !key.startsWith("alchemy.")),
            ),
            ...owner,
            [INSTANCE_TAG]: instanceId,
          };
          const desiredAccess = news.ipAccessList ?? [];
          let password = output?.password;
          let passwordDigest = output?.passwordDigest;

          // Observe: the ID in state, else a service this logical ID
          // created whose ID never reached state.
          const found =
            (output?.serviceId
              ? yield* getLiveService(organizationId, output.serviceId)
              : undefined) ?? (yield* findOwned(id, instanceId, organizationId));

          // Ensure, then wait until the service settles.
          let current: service.Service;
          let serviceId: string;
          if (found?.id === undefined) {
            yield* session.note(`Creating ClickHouse Cloud service "${name}"...`);
            const created = yield* service
              .createService({
                organizationId,
                name,
                provider: news.provider,
                region: news.region,
                ipAccessList: desiredAccess,
                autoscalingMode: news.autoscalingMode,
                minReplicaMemoryGb: news.minReplicaMemoryGb,
                maxReplicaMemoryGb: news.maxReplicaMemoryGb,
                numReplicas: news.numReplicas,
                minReplicas: news.minReplicas,
                maxReplicas: news.maxReplicas,
                idleScaling: news.idleScaling,
                idleTimeoutMinutes: news.idleTimeoutMinutes,
                profile: news.profile,
                releaseChannel: news.releaseChannel,
                endpoints: news.endpoints,
                tags: Object.entries(desiredTags).map(([key, value]) => ({ key, value })),
                enableCoreDumps: news.enableCoreDumps,
                deletionProtection: news.deletionProtection,
                hasTransparentDataEncryption: news.hasTransparentDataEncryption,
                complianceType: news.complianceType,
                dataWarehouseId: news.dataWarehouseId,
                isReadonly: news.isReadonly,
                byocId: news.byocId,
                backupId: news.backupId,
                backupEncryptionConfig: news.backupEncryptionConfig,
                privatePreviewTermsChecked: news.privatePreviewTermsChecked,
              })
              .pipe(
                Effect.catchTag("InstanceLimitReached", (cause) =>
                  Effect.fail(
                    new ServiceLimitReached({ organizationId, serviceName: name, cause }),
                  ),
                ),
                Effect.flatMap(requireResult("createService")),
              );
            // The generated password is returned only now.
            if (created.password !== undefined) {
              password = Redacted.isRedacted(created.password)
                ? created.password
                : Redacted.make(created.password);
            }
            passwordDigest = undefined;
            if (created.service?.id === undefined) {
              return yield* new ResultMissing({ operation: "createService (service id)" });
            }
            serviceId = created.service.id;
            current = yield* settle(organizationId, serviceId, session);
          } else {
            serviceId = found.id;
            current =
              isRunning(found.state) || found.state === "stopped"
                ? found
                : yield* settle(organizationId, serviceId, session);
          }

          // A stopped service that should run starts before the rest syncs.
          if ((news.state ?? "running") === "running" && current.state === "stopped") {
            current = yield* setState(organizationId, serviceId, "start", session);
          }

          // Sync basic details against observed state, in one PATCH.
          const observedTags = current.tags ?? [];
          const tagsToRemove = observedTags.filter((t) => desiredTags[t.key] !== (t.value ?? ""));
          const tagsToAdd = Object.entries(desiredTags)
            .filter(
              ([key, value]) =>
                !observedTags.some((t) => t.key === key && (t.value ?? "") === value),
            )
            .map(([key, value]) => ({ key, value }));
          const observedAccess = current.ipAccessList ?? [];
          const accessToRemove = observedAccess.filter(
            (o) => !desiredAccess.some((d) => sameEntry(o, d)),
          );
          const accessToAdd = desiredAccess.filter(
            (d) => !observedAccess.some((o) => sameEntry(o, d)),
          );
          const mysqlObserved = (current.endpoints ?? []).some((e) => e.protocol === "mysql");
          const endpointChanges = (news.endpoints ?? []).filter((e) => e.enabled !== mysqlObserved);
          const patch: Omit<service.UpdateServiceRequest, "organizationId" | "serviceId"> = {
            ...(current.name !== name ? { name } : {}),
            ...(accessToAdd.length > 0 || accessToRemove.length > 0
              ? {
                  ipAccessList: {
                    ...(accessToRemove.length > 0 ? { remove: accessToRemove } : {}),
                    ...(accessToAdd.length > 0 ? { add: accessToAdd } : {}),
                  },
                }
              : {}),
            ...(tagsToAdd.length > 0 || tagsToRemove.length > 0
              ? {
                  tags: {
                    ...(tagsToRemove.length > 0 ? { remove: tagsToRemove } : {}),
                    ...(tagsToAdd.length > 0 ? { add: tagsToAdd } : {}),
                  },
                }
              : {}),
            ...(news.releaseChannel !== undefined && news.releaseChannel !== current.releaseChannel
              ? { releaseChannel: news.releaseChannel }
              : {}),
            ...(endpointChanges.length > 0 ? { endpoints: endpointChanges } : {}),
            ...(news.enableCoreDumps !== undefined &&
            news.enableCoreDumps !== current.enableCoreDumps
              ? { enableCoreDumps: news.enableCoreDumps }
              : {}),
            ...((news.deletionProtection ?? false) !== (current.deletionProtection ?? false)
              ? { deletionProtection: news.deletionProtection ?? false }
              : {}),
            ...(news.transparentDataEncryptionKeyId !== undefined &&
            news.transparentDataEncryptionKeyId !== current.transparentDataEncryptionKeyId
              ? { transparentDataEncryptionKeyId: news.transparentDataEncryptionKeyId }
              : {}),
          };
          if (Object.keys(patch).length > 0) {
            current = yield* service
              .updateService({ organizationId, serviceId, ...patch })
              .pipe(Effect.flatMap(requireResult("updateService")));
          }

          // Sync scaling: only the props the user declared, sent together
          // when any of them differs from the service.
          const scaling = {
            autoscalingMode: news.autoscalingMode,
            minReplicaMemoryGb: news.minReplicaMemoryGb,
            maxReplicaMemoryGb: news.maxReplicaMemoryGb,
            numReplicas: news.numReplicas,
            minReplicas: news.minReplicas,
            maxReplicas: news.maxReplicas,
            idleScaling: news.idleScaling,
            idleTimeoutMinutes: news.idleTimeoutMinutes,
            profile: news.profile,
          };
          const declared = Object.fromEntries(
            Object.entries(scaling).filter(([, value]) => value !== undefined),
          ) as Partial<typeof scaling>;
          const scalingDrift = (Object.keys(declared) as (keyof typeof scaling)[]).some(
            (key) => declared[key] !== current[key],
          );
          if (scalingDrift) {
            yield* session.note("Updating the service's scaling...");
            yield* service.updateServiceReplicaScaling({ organizationId, serviceId, ...declared });
            current = yield* settle(organizationId, serviceId, session);
          }

          // Replica-aware routing, only when declared.
          let routing = output?.replicaAwareRouting;
          if (news.replicaAwareRouting !== undefined) {
            const observedRouting = yield* readRouting(organizationId, serviceId);
            const wantHttp = news.replicaAwareRouting.http;
            const wantNative = news.replicaAwareRouting.native;
            if (
              (wantHttp !== undefined && wantHttp !== observedRouting.http) ||
              (wantNative !== undefined && wantNative !== observedRouting.native)
            ) {
              const updated = yield* service
                .updateReplicaAwareRouting({
                  organizationId,
                  serviceId,
                  httpEnabled: wantHttp,
                  nativeEnabled: wantNative,
                })
                .pipe(Effect.flatMap(requireResult("updateReplicaAwareRouting")));
              routing = { http: updated.httpEnabled, native: updated.nativeEnabled };
            } else {
              routing = observedRouting;
            }
          }

          // Password: write-only, so the digest of the last applied value is
          // the only baseline. Only hashes leave this machine.
          if (news.password !== undefined) {
            const digest = passwordDigestOf(news.password);
            if (
              passwordDigest === undefined ||
              Redacted.value(passwordDigest) !== Redacted.value(digest)
            ) {
              const plain = Redacted.value(news.password);
              yield* service.updateServicePassword({
                organizationId,
                serviceId,
                newPasswordHash: Redacted.make(passwordHash(plain)),
                newDoubleSha1Hash: Redacted.make(doubleSha1Hash(plain)),
              });
            }
            password = news.password;
            passwordDigest = digest;
          }

          // Desired state last: a service that should be stopped stops after
          // every other change applied.
          if (news.state === "stopped" && current.state !== "stopped") {
            current = yield* setState(organizationId, serviceId, "stop", session);
          }

          const final = (yield* getLiveService(organizationId, serviceId)) ?? current;
          return toAttributes(organizationId, final, { password, passwordDigest }, routing);
        }),
        delete: Effect.fn(function* ({ output, session }) {
          const { organizationId, serviceId } = output;
          let observed = yield* getLiveService(organizationId, serviceId);
          if (observed === undefined) return;
          // The API deletes only stopped services.
          if (!isRunning(observed.state) && observed.state !== "stopped") {
            observed = yield* settle(organizationId, serviceId, session);
          }
          if (observed.state !== "stopped") {
            yield* setState(organizationId, serviceId, "stop", session);
          }
          yield* session.note("Deleting the service...");
          const deleteService = service.deleteService({ organizationId, serviceId }).pipe(
            Effect.catchTags({
              NotFound: () => Effect.void,
              DeletionProtectionEnabled: (cause) =>
                Effect.fail(
                  new ServiceDeletionProtected({
                    serviceId,
                    serviceName: observed?.name ?? output.name,
                    cause,
                  }),
                ),
            }),
          );
          // A query can wake the service between the stop and the delete;
          // the API then refuses to terminate it (ServiceNotTerminable), so
          // it is stopped again and deleted once more.
          yield* deleteService.pipe(
            Effect.catchTag("ServiceNotTerminable", () =>
              setState(organizationId, serviceId, "stop", session).pipe(
                Effect.andThen(deleteService),
              ),
            ),
          );
          yield* waitUntilServiceGone({ organizationId, serviceId, session });
        }),
      };
    }),
  );
