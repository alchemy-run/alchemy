import * as organization from "@distilled.cloud/clickhouse-cloud/organization";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { ByocValidationFailed, ResultMissing, requireResult } from "../Errors.ts";
import { ownerTags } from "../internal/Names.ts";
import { pollUntil } from "../internal/Wait.ts";
import type { Providers } from "../Providers.ts";

/** When ClickHouse personnel may access the infrastructure. */
export interface CustomerAuthorizedAccess {
  /** `always`, `never`, or `window` (one window from `startTimestamp` for `durationSeconds`). */
  mode: "always" | "never" | "window";
  /** Start of the window, ISO 8601. Only with `mode: "window"`. */
  startTimestamp?: string;
  /** Length of the window in seconds, 1 to 172800 (48 hours). Only with `mode: "window"`. */
  durationSeconds?: number;
}

export interface ByocInfrastructureProps {
  /** Region of the infrastructure, e.g. `us-east-1`. Changing it replaces the infrastructure. */
  regionId: organization.CreateByocInfrastructureRequest["regionId"];
  /**
   * Cloud account the infrastructure runs in: AWS account ID, GCP project
   * ID or Azure subscription ID, onboarded for ClickHouse BYOC. Changing it
   * replaces the infrastructure.
   */
  accountId: string;
  /** Availability zone suffixes, e.g. `["a", "b", "c"]`. Changing them replaces the infrastructure. */
  availabilityZoneSuffixes?: organization.CreateByocInfrastructureRequestAvailabilityZoneSuffixesItem[];
  /** CIDR of the ClickHouse-managed VPC; not with the BYO-VPC fields. Changing it replaces the infrastructure. */
  vpcCidrRange?: string;
  /** AWS: the ExternalID in the ClickHouse management role's trust policy. Changing it replaces the infrastructure. */
  externalId?: string;
  /** Azure: Entra tenant ID. Changing it replaces the infrastructure. */
  tenantId?: string;
  /** Azure: client ID of the service principal ClickHouse manages the infrastructure with. Changing it replaces the infrastructure. */
  servicePrincipalClientId?: string;
  /** BYO-VPC: your VPC ID or network name. Changing it replaces the infrastructure. */
  vpcId?: string;
  /** BYO-VPC: private subnet IDs or names. Changing them replaces the infrastructure. */
  privateSubnetIds?: string[];
  /** AWS BYO-VPC: public subnet IDs. Changing them replaces the infrastructure. */
  publicSubnetIds?: string[];
  /** GCP BYO-VPC: secondary range names for pod IPs. Changing them replaces the infrastructure. */
  gcpPodCidrRangeNames?: string[];
  /** GCP BYO-VPC: Shared VPC host project. Changing it replaces the infrastructure. */
  gcpSharedVpcHostProjectId?: string;
  /** Display name. */
  displayName?: string;
  /**
   * Tags on the cloud resources ClickHouse creates. Alchemy adds its
   * `alchemy.stack`, `alchemy.stage` and `alchemy.id` tags.
   */
  tags?: Record<string, string>;
  /** Private link connectivity. Disabling is refused while a service has private endpoints. */
  enablePrivateLink?: boolean;
  /** GCP BYO-VPC: Private Service Connect NAT subnet, needed to enable private link. */
  gcpPscSubnetId?: string;
  /** The private (internal) load balancer. */
  enablePrivateLoadBalancer?: boolean;
  /** The public (internet-facing) load balancer. */
  enablePublicLoadBalancer?: boolean;
  /** When ClickHouse personnel may access the infrastructure. Omit to leave it alone. */
  customerAuthorizedAccess?: CustomerAuthorizedAccess;
}

export interface ByocInfrastructureAttributes {
  /** BYOC infrastructure ID: pass it as a service's `byocId`. */
  byocInfrastructureId: string;
  /** Organization ID. */
  organizationId: string;
  /** `infra-ready`, `infra-provisioning`, `infra-upgrading`, `infra-degraded`, …. */
  state: string | undefined;
  /** Cloud account ID. */
  accountId: string | undefined;
  /** Region. */
  regionId: string | undefined;
  /** `aws`, `gcp` or `azure`. */
  cloudProvider: string | undefined;
  /** Display name. */
  displayName: string | undefined;
  /** Whether private link is on. */
  enablePrivateLink: boolean | undefined;
  /** Whether the private load balancer is on. */
  enablePrivateLoadBalancer: boolean | undefined;
  /** Whether the public load balancer is on. */
  enablePublicLoadBalancer: boolean | undefined;
  /** Availability zones. */
  vpcAvailabilityZoneList: string[];
  /** Whether the infrastructure runs in your own VPC. */
  isByoVpc: boolean | undefined;
  /** Tags on the cloud resources. */
  tags: Record<string, string>;
  /** Private link endpoint service, when private link is on. */
  privateEndpointConfig: { endpointName: string; privateDnsHostname: string } | undefined;
}

export type ByocInfrastructure = Resource<
  "ClickHouseCloud.Organization.ByocInfrastructure",
  ByocInfrastructureProps,
  ByocInfrastructureAttributes,
  never,
  Providers
>;

/**
 * BYOC ("Bring Your Own Cloud") infrastructure: the VPC and Kubernetes
 * cluster ClickHouse runs inside your own AWS, GCP or Azure account, for
 * services created with its `byocInfrastructureId` as `byocId`.
 *
 * The cloud account must be onboarded first (ClickHouse's management role
 * or service principal), and the organization needs BYOC enabled by
 * ClickHouse. Deploy validates the account before creating anything and
 * fails with `ByocValidationFailed`, naming each denied check, instead of
 * failing late in provisioning. Provisioning takes tens of minutes; deploy
 * returns once the infrastructure is `infra-ready`. The location fields
 * are fixed at creation: changing them replaces the infrastructure.
 * @see https://clickhouse.com/docs/cloud/reference/byoc
 *
 * ### Creating Infrastructure
 * **Example:** A ClickHouse-managed VPC in your AWS account
 * ```typescript
 * const byoc = yield* ClickHouseCloud.Organization.ByocInfrastructure("Byoc", {
 *   regionId: "us-east-1",
 *   accountId: "123456789012",
 *   externalId: "<external id in the management role's trust policy>",
 *   vpcCidrRange: "10.10.0.0/16",
 *   availabilityZoneSuffixes: ["a", "b", "c"],
 *   displayName: "analytics",
 * });
 * yield* ClickHouseCloud.Service.Service("Warehouse", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   byocId: byoc.byocInfrastructureId,
 *   minReplicaMemoryGb: 16,
 *   maxReplicaMemoryGb: 64,
 *   ipAccessList: [{ source: "10.0.0.0/8" }],
 * });
 * ```
 *
 * ### Access by ClickHouse Support
 * **Example:** Allow access for one 24-hour window
 * ```typescript
 * yield* ClickHouseCloud.Organization.ByocInfrastructure("Byoc", {
 *   regionId: "us-east-1",
 *   accountId: "123456789012",
 *   externalId: "<external id>",
 *   customerAuthorizedAccess: {
 *     mode: "window",
 *     startTimestamp: "2026-12-01T09:00:00Z",
 *     durationSeconds: 86_400,
 *   },
 * });
 * ```
 *
 * :::caution
 * Changing the region, account or VPC fields replaces the infrastructure,
 * and every service on it must be deleted first.
 * :::
 *
 * @resource
 * @product BYOC
 */
export const ByocInfrastructure = Resource<ByocInfrastructure>(
  "ClickHouseCloud.Organization.ByocInfrastructure",
);

const CREATE_ONLY = [
  "regionId",
  "accountId",
  "availabilityZoneSuffixes",
  "vpcCidrRange",
  "externalId",
  "tenantId",
  "servicePrincipalClientId",
  "vpcId",
  "privateSubnetIds",
  "publicSubnetIds",
  "gcpPodCidrRangeNames",
  "gcpSharedVpcHostProjectId",
] as const satisfies ReadonlyArray<keyof ByocInfrastructureProps>;

const READY = "infra-ready";
const GONE: Partial<Record<string, true>> = {
  "infra-terminating": true,
  "infra-terminated": true,
};

const getInfra = (organizationId: string, byocInfrastructureId: string) =>
  organization.getByocInfrastructure({ organizationId, byocInfrastructureId }).pipe(
    Effect.flatMap(requireResult("getByocInfrastructure")),
    Effect.map((infra) => (GONE[infra.state ?? ""] ? undefined : infra)),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const getTags = (organizationId: string, byocInfrastructureId: string) =>
  organization.getByocInfrastructureTags({ organizationId, byocInfrastructureId }).pipe(
    Effect.flatMap(requireResult("getByocInfrastructureTags")),
    Effect.map(
      (r) =>
        Object.fromEntries(
          Object.entries(r.tags).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]])),
        ) as Record<string, string>,
    ),
  );

const toAttributes = (
  organizationId: string,
  infra: organization.ByocInfrastructureDetails,
  tags: Record<string, string>,
  privateEndpointConfig: ByocInfrastructureAttributes["privateEndpointConfig"],
): ByocInfrastructureAttributes => ({
  byocInfrastructureId: infra.id ?? "",
  organizationId,
  state: infra.state,
  accountId: infra.accountId,
  regionId: infra.regionId,
  cloudProvider: infra.cloudProvider,
  displayName: infra.displayName,
  enablePrivateLink: infra.enablePrivateLink,
  enablePrivateLoadBalancer: infra.enablePrivateLoadBalancer,
  enablePublicLoadBalancer: infra.enablePublicLoadBalancer,
  vpcAvailabilityZoneList: infra.vpcAvailabilityZoneList ?? [],
  isByoVpc: infra.isByoVpc,
  tags,
  privateEndpointConfig,
});

const waitReady = (
  organizationId: string,
  id: string,
  session: { note: (m: string) => Effect.Effect<void> },
) =>
  pollUntil({
    kind: "BYOC infrastructure",
    id,
    waitingFor: READY,
    read: getInfra(organizationId, id),
    state: (infra) => infra?.state,
    done: (infra): infra is organization.ByocInfrastructureDetails => infra?.state === READY,
    failed: (infra) => (infra === undefined ? "deleted while provisioning" : undefined),
    session,
    budget: Duration.minutes(90),
    interval: Duration.seconds(30),
  });

export const ByocInfrastructureProvider = () =>
  Provider.effect(
    ByocInfrastructure,
    Effect.gen(function* () {
      const findByLocation = (organizationId: string, regionId: string, accountId: string) =>
        organization.getOrganization({ organizationId }).pipe(
          Effect.flatMap(requireResult("getOrganization")),
          Effect.map((org) =>
            (org.byocConfig ?? []).find(
              (b) =>
                b.regionId === regionId &&
                b.accountId === accountId &&
                !GONE[b.state ?? ""] &&
                b.id !== undefined,
            ),
          ),
        );
      const privateEndpoint = (organizationId: string, id: string, enabled: boolean | undefined) =>
        enabled
          ? organization
              .getByocInfrastructurePrivateEndpointConfig({
                organizationId,
                byocInfrastructureId: id,
              })
              .pipe(Effect.flatMap(requireResult("getByocInfrastructurePrivateEndpointConfig")))
          : Effect.succeed(undefined);

      return {
        stables: [
          "byocInfrastructureId",
          "organizationId",
          "accountId",
          "regionId",
          "cloudProvider",
        ],
        list: Effect.fn(function* () {
          const organizationId = yield* currentOrganizationId;
          const org = yield* organization
            .getOrganization({ organizationId })
            .pipe(Effect.flatMap(requireResult("getOrganization")));
          const owned: ByocInfrastructureAttributes[] = [];
          for (const b of org.byocConfig ?? []) {
            if (b.id === undefined || GONE[b.state ?? ""]) continue;
            const tags = yield* getTags(organizationId, b.id);
            if (tags["alchemy.stack"] === undefined) continue;
            owned.push(toAttributes(organizationId, b, tags, undefined));
          }
          return owned;
        }),
        diff: Effect.fn(function* ({ news, olds, output }) {
          if (!isResolved(news) || output === undefined || olds === undefined) return undefined;
          if (CREATE_ONLY.some((key) => !deepEqual(news[key], olds[key]))) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
          const found = output?.byocInfrastructureId
            ? { id: output.byocInfrastructureId }
            : yield* findByLocation(organizationId, olds.regionId, olds.accountId);
          if (found?.id === undefined) return undefined;
          const infra = yield* getInfra(organizationId, found.id);
          if (infra === undefined) return undefined;
          const tags = yield* getTags(organizationId, found.id);
          const attrs = toAttributes(organizationId, infra, tags, output?.privateEndpointConfig);
          if (output !== undefined) return attrs;
          const owner = yield* ownerTags(id);
          const ours = Object.entries(owner).every(([k, v]) => tags[k] === v);
          return ours ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
          const owner = yield* ownerTags(id);
          const desiredTags = {
            ...Object.fromEntries(
              Object.entries(news.tags ?? {}).filter(([k]) => !k.startsWith("alchemy.")),
            ),
            ...owner,
          };
          const location = {
            organizationId,
            regionId: news.regionId,
            accountId: news.accountId,
            availabilityZoneSuffixes: news.availabilityZoneSuffixes,
            vpcCidrRange: news.vpcCidrRange,
            externalId: news.externalId,
            tenantId: news.tenantId,
            servicePrincipalClientId: news.servicePrincipalClientId,
            vpcId: news.vpcId,
            privateSubnetIds: news.privateSubnetIds,
            publicSubnetIds: news.publicSubnetIds,
            gcpPodCidrRangeNames: news.gcpPodCidrRangeNames,
            gcpSharedVpcHostProjectId: news.gcpSharedVpcHostProjectId,
            tags: desiredTags,
          };

          // Observe
          let infraId = output?.byocInfrastructureId;
          if (infraId !== undefined && (yield* getInfra(organizationId, infraId)) === undefined) {
            infraId = undefined;
          }
          infraId ??= (yield* findByLocation(organizationId, news.regionId, news.accountId))?.id;

          // Ensure: validate first, so a missing permission fails now.
          if (infraId === undefined) {
            const validation = yield* organization
              .validateByocInfrastructure(location)
              .pipe(Effect.flatMap(requireResult("validateByocInfrastructure")));
            if (validation.supported && !validation.allPassed) {
              return yield* new ByocValidationFailed({
                checks: (validation.checks ?? [])
                  .filter((c) => c.allowed === false)
                  .map((c) => ({ name: c.name ?? c.action ?? "check", reason: c.reason })),
              });
            }
            yield* session.note("Creating the BYOC infrastructure...");
            const created = yield* organization
              .createByocInfrastructure({ ...location, displayName: news.displayName })
              .pipe(Effect.flatMap(requireResult("createByocInfrastructure")));
            if (created.id === undefined) {
              return yield* new ResultMissing({ operation: "createByocInfrastructure (id)" });
            }
            infraId = created.id;
          }
          let infra = yield* waitReady(organizationId, infraId, session);

          // Sync: one PATCH with every changed setting; tags replace as a whole.
          const observedTags = yield* getTags(organizationId, infraId);
          const patch = {
            ...(news.displayName !== undefined && news.displayName !== infra?.displayName
              ? { displayName: news.displayName }
              : {}),
            ...(news.enablePrivateLink !== undefined &&
            news.enablePrivateLink !== infra?.enablePrivateLink
              ? {
                  enablePrivateLink: news.enablePrivateLink,
                  ...(news.gcpPscSubnetId !== undefined
                    ? { gcpPscSubnetId: news.gcpPscSubnetId }
                    : {}),
                }
              : {}),
            ...(news.enablePrivateLoadBalancer !== undefined &&
            news.enablePrivateLoadBalancer !== infra?.enablePrivateLoadBalancer
              ? { enablePrivateLoadBalancer: news.enablePrivateLoadBalancer }
              : {}),
            ...(news.enablePublicLoadBalancer !== undefined &&
            news.enablePublicLoadBalancer !== infra?.enablePublicLoadBalancer
              ? { enablePublicLoadBalancer: news.enablePublicLoadBalancer }
              : {}),
            ...(!deepEqual(observedTags, desiredTags) ? { tags: desiredTags } : {}),
          };
          if (Object.keys(patch).length > 0) {
            yield* organization.updateByocInfrastructure({
              organizationId,
              byocInfrastructureId: infraId,
              ...patch,
            });
            infra = yield* waitReady(organizationId, infraId, session);
          }

          if (news.customerAuthorizedAccess !== undefined) {
            const access = yield* organization
              .getByocInfrastructureCustomerAuthorizedAccess({
                organizationId,
                byocInfrastructureId: infraId,
              })
              .pipe(Effect.flatMap(requireResult("getByocInfrastructureCustomerAuthorizedAccess")));
            const want = news.customerAuthorizedAccess;
            if (
              access.mode !== want.mode ||
              (want.mode === "window" &&
                (access.startTimestamp !== want.startTimestamp ||
                  access.durationSeconds !== want.durationSeconds))
            ) {
              yield* organization.updateByocInfrastructureCustomerAuthorizedAccess({
                organizationId,
                byocInfrastructureId: infraId,
                ...want,
              });
            }
          }

          const tags = yield* getTags(organizationId, infraId);
          const endpoint = yield* privateEndpoint(
            organizationId,
            infraId,
            infra?.enablePrivateLink,
          );
          return toAttributes(organizationId, infra, tags, endpoint);
        }),
        delete: Effect.fn(function* ({ output, session }) {
          const { organizationId, byocInfrastructureId } = output;
          if ((yield* getInfra(organizationId, byocInfrastructureId)) === undefined) return;
          yield* session.note("Deleting the BYOC infrastructure...");
          yield* organization
            .deleteByocInfrastructure({ organizationId, byocInfrastructureId })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
          yield* pollUntil({
            kind: "BYOC infrastructure",
            id: byocInfrastructureId,
            waitingFor: "deleted",
            read: getInfra(organizationId, byocInfrastructureId),
            state: (infra) => infra?.state,
            done: (infra): infra is undefined => infra === undefined,
            session,
            budget: Duration.minutes(90),
            interval: Duration.seconds(30),
          });
        }),
      };
    }),
  );
