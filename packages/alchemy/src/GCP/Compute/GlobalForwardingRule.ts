import * as compute from "@distilled.cloud/gcp/compute_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { waitGlobalOperations } from "./operations.ts";

const DEFAULT_PROTOCOL = "TCP";
const DEFAULT_SCHEME = "EXTERNAL";
const DEFAULT_TIER = "PREMIUM";
const MAX_NAME_LENGTH = 63;

export type GlobalForwardingRuleProps = {
  /**
   * Name of the forwarding rule. If omitted, a unique RFC1035 name is
   * generated from the stack, stage, and logical id. Immutable —
   * changing it replaces the rule.
   */
  forwardingRuleName?: string;
  /**
   * Optional description. Immutable — changing it replaces the rule.
   */
  description?: string;
  /**
   * URL of the target that receives matched traffic (a global target
   * HTTP/HTTPS/SSL/TCP/gRPC proxy self-link, a PSC service attachment,
   * or `all-apis` / `vpc-sc`).
   */
  target: string;
  /**
   * IP this rule accepts traffic on. A reserved global address
   * (self-link, `global/addresses/name`, or the IP itself). If omitted,
   * GCP assigns an ephemeral address. Immutable.
   */
  ipAddress?: string;
  /**
   * IP protocol (`TCP`, `UDP`, `ESP`, `AH`, `SCTP`, `ICMP`,
   * `L3_DEFAULT`). Immutable.
   * @default "TCP"
   */
  ipProtocol?: compute.ForwardingRuleIPProtocolEnum | (string & {});
  /**
   * `IPV4` or `IPV6`. Immutable.
   */
  ipVersion?: compute.ForwardingRuleIpVersionEnum | (string & {});
  /**
   * Port or range (`80` or `80-80`). Required for HTTP(S) / proxy NLB
   * frontends. Immutable.
   */
  portRange?: string;
  /**
   * Forwarding-rule type. `EXTERNAL` is classic HTTP(S) LB;
   * `EXTERNAL_MANAGED` is the global external Application Load
   * Balancer. Immutable — changing it replaces the rule.
   * @default "EXTERNAL"
   */
  loadBalancingScheme?:
    | compute.ForwardingRuleLoadBalancingSchemeEnum
    | (string & {});
  /**
   * VPC network URL. Unused for external HTTP(S) LB; required for
   * PSC-to-Google-APIs. Immutable.
   */
  network?: string;
  /**
   * Networking tier. Global forwarding rules only support `PREMIUM`.
   * Mutable via `patch`.
   * @default "PREMIUM"
   */
  networkTier?: compute.ForwardingRuleNetworkTierEnum | (string & {});
  /**
   * User labels. Alchemy ownership labels are merged in and synced via
   * `setLabels` (labels cannot be set on insert).
   */
  labels?: Record<string, string>;
  /**
   * xDS metadata filters (`INTERNAL_SELF_MANAGED` only). Immutable.
   */
  metadataFilters?: compute.MetadataFilter[];
  /**
   * Restrict forwarding to these source IPs / CIDRs (regional EXTERNAL
   * only). Immutable.
   */
  sourceIpRanges?: string[];
  /**
   * Skip auto-creating a DNS zone on a PSC consumer rule. Immutable.
   */
  noAutomateDnsZone?: boolean;
  /**
   * Service Directory registration (PSC for Google APIs). Immutable.
   */
  serviceDirectoryRegistrations?: compute.ForwardingRuleServiceDirectoryRegistration[];
  /**
   * Public delegated prefix URL for BYOIP IPv6. Immutable.
   */
  ipCollection?: string;
  /**
   * Canary state when migrating backend buckets from `EXTERNAL` to
   * `EXTERNAL_MANAGED` (`PREPARE`, `TEST_BY_PERCENTAGE`,
   * `TEST_ALL_TRAFFIC`).
   */
  externalManagedBackendBucketMigrationState?:
    | compute.ForwardingRuleExternalManagedBackendBucketMigrationStateEnum
    | (string & {});
  /**
   * Percent of backend-bucket traffic on the new scheme when the
   * migration state is `TEST_BY_PERCENTAGE` (`0`–`100`).
   */
  externalManagedBackendBucketMigrationTestingPercentage?: number;
};

export type GlobalForwardingRule = Resource<
  "GCP.Compute.GlobalForwardingRule",
  GlobalForwardingRuleProps,
  {
    /** RFC1035 resource name. */
    forwardingRuleName: string;
    /** Project id. */
    project: string;
    /** Server-assigned numeric id. */
    forwardingRuleId: string | undefined;
    /** Compute self-link. */
    selfLink: string | undefined;
    /** Assigned IP address number. */
    ipAddress: string | undefined;
    /** IP protocol. */
    ipProtocol: string | undefined;
    /** `IPV4` or `IPV6`. */
    ipVersion: string | undefined;
    /** Port or range. */
    portRange: string | undefined;
    /** Target proxy / PSC URL. */
    target: string | undefined;
    /** Load balancer type. */
    loadBalancingScheme: string | undefined;
    /** Networking tier. */
    networkTier: string | undefined;
    /** Network URL, if set. */
    network: string | undefined;
    /** Description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Optimistic-locking fingerprint. */
    fingerprint: string | undefined;
    /** Label fingerprint for `setLabels`. */
    labelFingerprint: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** PSC connection id, if this is a PSC rule. */
    pscConnectionId: string | undefined;
    /** PSC connection status, if this is a PSC rule. */
    pscConnectionStatus: string | undefined;
    /** Base forwarding-rule URL when `sourceIpRanges` is set. */
    baseForwardingRule: string | undefined;
    /** Resource kind (`compute#forwardingRule`). */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A global Compute Engine forwarding rule — the frontend of a global
 * load balancer. It binds an IP and port range to a target HTTP/HTTPS
 * proxy (or SSL/TCP/gRPC proxy, or a Private Service Connect bundle).
 *
 * Labels cannot be set on insert — Alchemy applies them with
 * `setLabels` after the rule exists. `target` and `networkTier` update
 * in place (`setTarget` / `patch`). Name, IP, protocol, port range,
 * description, network, and load-balancing scheme replace the rule.
 *
 * ### Creating a Global Forwarding Rule
 * **Example:** HTTP frontend in front of a target HTTP proxy
 * ```typescript
 * const map = yield* GCP.Compute.UrlMap("web", {
 *   defaultUrlRedirect: {
 *     httpsRedirect: true,
 *     hostRedirect: "example.com",
 *     stripQuery: false,
 *   },
 * });
 * const proxy = yield* GCP.Compute.TargetHttpProxy("http", {
 *   urlMap: map.urlMapName,
 * });
 * const rule = yield* GCP.Compute.GlobalForwardingRule("frontend", {
 *   target: proxy.selfLink,
 *   portRange: "80",
 * });
 * ```
 *
 * **Example:** Named rule with labels and a reserved IP
 * ```typescript
 * const ip = yield* GCP.Compute.GlobalAddress("FrontendIp", {});
 * const rule = yield* GCP.Compute.GlobalForwardingRule("frontend", {
 *   forwardingRuleName: "app-http",
 *   description: "public HTTP frontend",
 *   target: proxy.selfLink,
 *   ipAddress: ip.address,
 *   portRange: "80",
 *   loadBalancingScheme: "EXTERNAL",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Global Forwarding Rule
 * **Example:** Retarget and relabel
 * ```typescript
 * const rule = yield* GCP.Compute.GlobalForwardingRule("frontend", {
 *   forwardingRuleName: "app-http",
 *   target: otherProxy.selfLink,
 *   portRange: "80",
 *   labels: { env: "prod", role: "edge" },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Compute
 */
export const GlobalForwardingRule = Resource<GlobalForwardingRule>(
  "GCP.Compute.GlobalForwardingRule",
);

export class GlobalForwardingRuleNotResolved extends Data.TaggedError(
  "GCP.Compute.GlobalForwardingRuleNotResolved",
)<{
  forwardingRuleName: string;
}> {}

export class GlobalForwardingRulePending extends Data.TaggedError(
  "GCP.Compute.GlobalForwardingRulePending",
)<{
  forwardingRuleName: string;
  status: string;
}> {}

export class GlobalForwardingRuleOperationFailed extends Data.TaggedError(
  "GCP.Compute.GlobalForwardingRuleOperationFailed",
)<{
  forwardingRuleName: string;
  operation: string;
  message: string;
}> {}

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    return /^[a-z]/.test(generated)
      ? generated
      : `f${generated}`.slice(0, MAX_NAME_LENGTH);
  });

const resourceTail = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const parts = value.split("/").filter((part) => part.length > 0);
  return (parts[parts.length - 1] ?? "").toLowerCase();
};

const normalizePortRange = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? `${trimmed}-${trimmed}` : trimmed;
};

const isRawIp = (value: string): boolean =>
  !value.includes("/") && (value.includes(".") || value.includes(":"));

const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const schemeOf = (value: string | undefined) => value ?? DEFAULT_SCHEME;

const protocolOf = (value: string | undefined) =>
  (value ?? DEFAULT_PROTOCOL).toUpperCase();

const tierOf = (value: string | undefined) => value ?? DEFAULT_TIER;

const ipVersionOf = (value: string | undefined) =>
  value && value !== "UNSPECIFIED_VERSION" ? value : "";

const toAttrs = (rule: compute.ForwardingRule, project: string) => ({
  forwardingRuleName: rule.name ?? "",
  project,
  forwardingRuleId: rule.id,
  selfLink: rule.selfLink,
  ipAddress: rule.IPAddress,
  ipProtocol: rule.IPProtocol,
  ipVersion: rule.ipVersion,
  portRange: rule.portRange,
  target: rule.target,
  loadBalancingScheme: rule.loadBalancingScheme,
  networkTier: rule.networkTier,
  network: rule.network,
  description: rule.description,
  labels: userLabels(rule.labels),
  fingerprint: rule.fingerprint,
  labelFingerprint: rule.labelFingerprint,
  creationTimestamp: rule.creationTimestamp,
  pscConnectionId: rule.pscConnectionId,
  pscConnectionStatus: rule.pscConnectionStatus,
  baseForwardingRule: rule.baseForwardingRule,
  kind: rule.kind,
});

const toInsertBody = (
  forwardingRuleName: string,
  news: GlobalForwardingRuleProps,
): compute.ForwardingRule => {
  const body: compute.ForwardingRule = {
    name: forwardingRuleName,
    target: news.target,
    IPProtocol: news.ipProtocol ?? DEFAULT_PROTOCOL,
    loadBalancingScheme: news.loadBalancingScheme ?? DEFAULT_SCHEME,
    networkTier: news.networkTier ?? DEFAULT_TIER,
  };
  if (news.description !== undefined) body.description = news.description;
  if (news.ipAddress !== undefined) body.IPAddress = news.ipAddress;
  if (news.ipVersion !== undefined) body.ipVersion = news.ipVersion;
  if (news.portRange !== undefined) body.portRange = news.portRange;
  if (news.network !== undefined) body.network = news.network;
  if (news.metadataFilters !== undefined) {
    body.metadataFilters = news.metadataFilters;
  }
  if (news.sourceIpRanges !== undefined) {
    body.sourceIpRanges = news.sourceIpRanges;
  }
  if (news.noAutomateDnsZone !== undefined) {
    body.noAutomateDnsZone = news.noAutomateDnsZone;
  }
  if (news.serviceDirectoryRegistrations !== undefined) {
    body.serviceDirectoryRegistrations = news.serviceDirectoryRegistrations;
  }
  if (news.ipCollection !== undefined) {
    body.ipCollection = news.ipCollection;
  }
  if (news.externalManagedBackendBucketMigrationState !== undefined) {
    body.externalManagedBackendBucketMigrationState =
      news.externalManagedBackendBucketMigrationState;
  }
  if (
    news.externalManagedBackendBucketMigrationTestingPercentage !== undefined
  ) {
    body.externalManagedBackendBucketMigrationTestingPercentage =
      news.externalManagedBackendBucketMigrationTestingPercentage;
  }
  return body;
};

const operationId = (operation: compute.Operation) => {
  const name = operation.name ?? "";
  return name.split("/").pop() ?? name;
};

const operationText = (operation: compute.Operation) =>
  (operation.error?.errors ?? [])
    .map((error) => `${error.code ?? ""} ${error.message ?? ""}`)
    .join("; ")
    .toLowerCase();

const failIfOpError = (
  operation: compute.Operation,
  forwardingRuleName: string,
) => {
  const errors = operation.error?.errors ?? [];
  if (errors.length === 0) return Effect.void;
  const text = operationText(operation);
  if (text.includes("already_exists") || text.includes("already exists")) {
    return Effect.void;
  }
  if (text.includes("not_found") || text.includes("not found")) {
    return Effect.void;
  }
  return Effect.fail(
    new GlobalForwardingRuleOperationFailed({
      forwardingRuleName,
      operation: operation.name ?? "",
      message: errors
        .map((error) => error.message ?? error.code ?? "unknown")
        .join("; "),
    }),
  );
};

const getByName = (project: string, forwardingRule: string) =>
  compute
    .getGlobalForwardingRules({ project, forwardingRule })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitForOperation = (
  project: string,
  operation: compute.Operation,
  forwardingRuleName: string,
) =>
  Effect.gen(function* () {
    const name = operationId(operation);
    if (!name) {
      yield* failIfOpError(operation, forwardingRuleName);
      return;
    }
    const current =
      operation.status === "DONE"
        ? operation
        : yield* waitGlobalOperations(
            { project, operation: name },
            { times: 15 },
          );
    yield* failIfOpError(current, forwardingRuleName);
  });

const awaitResource = (project: string, forwardingRuleName: string) =>
  getByName(project, forwardingRuleName).pipe(
    Effect.flatMap((rule) =>
      rule === undefined
        ? Effect.fail(
            new GlobalForwardingRulePending({
              forwardingRuleName,
              status: "MISSING",
            }),
          )
        : Effect.succeed(rule),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.GlobalForwardingRulePending",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (project: string, forwardingRuleName: string) =>
  getByName(project, forwardingRuleName).pipe(
    Effect.flatMap((rule) =>
      rule === undefined
        ? Effect.void
        : Effect.fail(
            new GlobalForwardingRulePending({
              forwardingRuleName,
              status: "EXISTS",
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Compute.GlobalForwardingRulePending",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag(
      "GCP.Compute.GlobalForwardingRulePending",
      () => Effect.void,
    ),
  );

export const GlobalForwardingRuleProvider = () =>
  Provider.succeed(GlobalForwardingRule, {
    stables: [
      "forwardingRuleName",
      "project",
      "forwardingRuleId",
      "selfLink",
      "ipAddress",
      "ipProtocol",
      "ipVersion",
      "portRange",
      "loadBalancingScheme",
      "network",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName =
        olds?.forwardingRuleName ?? output?.forwardingRuleName;
      const nextName = news.forwardingRuleName ?? previousName;
      const nameChanged =
        previousName !== undefined &&
        nextName !== undefined &&
        nextName !== previousName;

      const previousProtocol = protocolOf(
        olds?.ipProtocol ?? output?.ipProtocol,
      );
      const previousPort = normalizePortRange(
        olds?.portRange ?? output?.portRange,
      );
      const nextPort = normalizePortRange(news.portRange);
      const previousNetwork = resourceTail(olds?.network ?? output?.network);
      const previousDescription =
        olds?.description ?? output?.description ?? "";
      const previousVersion = ipVersionOf(olds?.ipVersion ?? output?.ipVersion);
      const previousCollection = resourceTail(olds?.ipCollection);
      const previousDns = olds?.noAutomateDnsZone;
      const previousScheme = schemeOf(
        olds?.loadBalancingScheme ?? output?.loadBalancingScheme,
      );

      const previousIp = output?.ipAddress;
      const ipChanged =
        news.ipAddress !== undefined &&
        isRawIp(news.ipAddress) &&
        previousIp !== undefined &&
        news.ipAddress !== previousIp;

      const immutableChanged =
        (news.description !== undefined &&
          (news.description ?? "") !== previousDescription) ||
        ipChanged ||
        (news.ipProtocol !== undefined &&
          protocolOf(news.ipProtocol) !== previousProtocol) ||
        (news.ipVersion !== undefined &&
          ipVersionOf(news.ipVersion) !== previousVersion) ||
        (news.portRange !== undefined && nextPort !== previousPort) ||
        (news.loadBalancingScheme !== undefined &&
          schemeOf(news.loadBalancingScheme) !== previousScheme) ||
        (news.network !== undefined &&
          resourceTail(news.network) !== previousNetwork) ||
        (news.ipCollection !== undefined &&
          resourceTail(news.ipCollection) !== previousCollection) ||
        (news.noAutomateDnsZone !== undefined &&
          news.noAutomateDnsZone !== previousDns) ||
        (news.metadataFilters !== undefined &&
          !sameJson(news.metadataFilters, olds?.metadataFilters)) ||
        (news.sourceIpRanges !== undefined &&
          !sameJson(
            [...news.sourceIpRanges].sort(),
            [...(olds?.sourceIpRanges ?? [])].sort(),
          )) ||
        (news.serviceDirectoryRegistrations !== undefined &&
          !sameJson(
            news.serviceDirectoryRegistrations,
            olds?.serviceDirectoryRegistrations,
          ));

      if (nameChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (immutableChanged) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousName !== undefined &&
            (nextName === undefined || nextName === previousName),
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const forwardingRuleName = yield* toName(
        id,
        olds?.forwardingRuleName,
        output?.forwardingRuleName,
      );
      const existing = yield* getByName(env.project, forwardingRuleName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listGlobalForwardingRules
          .items({ project: env.project, maxResults: 500 })
          .pipe(
            Stream.filter((rule) =>
              Object.keys(rule.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            ),
            Stream.map((rule) => toAttrs(rule, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const forwardingRuleName = yield* toName(
        id,
        news.forwardingRuleName,
        output?.forwardingRuleName,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(env.project, forwardingRuleName);

      if (current === undefined) {
        const created = yield* compute
          .insertGlobalForwardingRules({
            project: env.project,
            body: toInsertBody(forwardingRuleName, news),
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitForOperation(env.project, operation, forwardingRuleName).pipe(
                Effect.flatMap(() =>
                  getByName(env.project, forwardingRuleName),
                ),
              ),
            ),
            Effect.catchTag("Conflict", () =>
              getByName(env.project, forwardingRuleName),
            ),
          );
        current = created ?? undefined;
        if (current === undefined) {
          current = yield* awaitResource(env.project, forwardingRuleName).pipe(
            Effect.catchTag("GCP.Compute.GlobalForwardingRulePending", () =>
              Effect.succeed(undefined),
            ),
          );
        }
      }

      if (current === undefined) {
        return yield* new GlobalForwardingRuleNotResolved({
          forwardingRuleName,
        });
      }
      const resolved = current;

      if (
        news.target !== undefined &&
        resourceTail(current.target) !== resourceTail(news.target)
      ) {
        yield* compute
          .setTargetGlobalForwardingRules({
            project: env.project,
            forwardingRule: forwardingRuleName,
            body: { target: news.target },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitForOperation(env.project, operation, forwardingRuleName),
            ),
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("2 seconds"),
            }),
          );
        current =
          (yield* getByName(env.project, forwardingRuleName)) ?? current;
      }

      const tierChanged =
        news.networkTier !== undefined &&
        tierOf(current.networkTier) !== tierOf(news.networkTier);
      const migrationStateChanged =
        news.externalManagedBackendBucketMigrationState !== undefined &&
        current.externalManagedBackendBucketMigrationState !==
          news.externalManagedBackendBucketMigrationState;
      const migrationPctChanged =
        news.externalManagedBackendBucketMigrationTestingPercentage !==
          undefined &&
        current.externalManagedBackendBucketMigrationTestingPercentage !==
          news.externalManagedBackendBucketMigrationTestingPercentage;

      if (tierChanged || migrationStateChanged || migrationPctChanged) {
        const patch: compute.ForwardingRule = {
          fingerprint: current.fingerprint,
        };
        if (tierChanged) patch.networkTier = news.networkTier;
        if (migrationStateChanged) {
          patch.externalManagedBackendBucketMigrationState =
            news.externalManagedBackendBucketMigrationState;
        }
        if (migrationPctChanged) {
          patch.externalManagedBackendBucketMigrationTestingPercentage =
            news.externalManagedBackendBucketMigrationTestingPercentage;
        }
        yield* compute
          .patchGlobalForwardingRules({
            project: env.project,
            forwardingRule: forwardingRuleName,
            body: patch,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitForOperation(env.project, operation, forwardingRuleName),
            ),
          );
        current =
          (yield* getByName(env.project, forwardingRuleName)) ?? current;
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      if (upsert.length > 0 || removed.length > 0) {
        yield* Effect.gen(function* () {
          const latest =
            (yield* getByName(env.project, forwardingRuleName)) ?? resolved;
          yield* compute
            .setLabelsGlobalForwardingRules({
              project: env.project,
              resource: forwardingRuleName,
              body: {
                labels: desiredLabels,
                labelFingerprint: latest.labelFingerprint,
              },
            })
            .pipe(
              Effect.flatMap((operation) =>
                waitForOperation(env.project, operation, forwardingRuleName),
              ),
            );
        }).pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
        current =
          (yield* getByName(env.project, forwardingRuleName)) ?? resolved;
      }

      return toAttrs(current ?? resolved, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      yield* compute
        .deleteGlobalForwardingRules({
          project: env.project,
          forwardingRule: output.forwardingRuleName,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitForOperation(env.project, operation, output.forwardingRuleName),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      yield* waitUntilGone(env.project, output.forwardingRuleName);
    }),
  });
