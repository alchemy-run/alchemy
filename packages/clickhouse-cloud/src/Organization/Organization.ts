import * as organization from "@distilled.cloud/clickhouse-cloud/organization";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { requireResult } from "../internal/Errors.ts";
import type { Providers } from "../Providers.ts";

export interface OrganizationProps {
  /** Organization name. Omit to leave it alone. */
  name?: string;
  /**
   * Whether services may collect core dumps. A service's own
   * `enableCoreDumps` has no effect while this is off. Omit to leave it
   * alone.
   */
  enableCoreDumps?: boolean;
}

/** The settings alchemy found before it first changed them. */
export interface OrganizationOriginal {
  /** Organization name. */
  name: string | undefined;
  /** Whether core dumps were enabled. */
  enableCoreDumps: boolean | undefined;
}

/** A private endpoint registered on the organization. */
export interface OrganizationPrivateEndpoint {
  /** Endpoint ID. */
  id: string | undefined;
  /** Description. */
  description: string | undefined;
  /** Cloud provider. */
  cloudProvider: string | undefined;
  /** Region. */
  region: string | undefined;
}

export interface OrganizationAttributes {
  /** Organization ID. */
  organizationId: string;
  /** Organization name. */
  name: string;
  /** When the organization was created. */
  createdAt: string | undefined;
  /** Whether services may collect core dumps. */
  enableCoreDumps: boolean | undefined;
  /** Private endpoints registered on the organization. */
  privateEndpoints: OrganizationPrivateEndpoint[];
  /** IDs of the organization's BYOC infrastructures. */
  byocInfrastructureIds: string[];
  /** Whether the organization can take service snapshots. */
  snapshots: boolean | undefined;
  /** The settings before alchemy first changed them; restored on destroy. */
  original: OrganizationOriginal;
}

export type Organization = Resource<
  "ClickHouseCloud.Organization.Organization",
  OrganizationProps,
  OrganizationAttributes,
  never,
  Providers
>;

/**
 * The ClickHouse Cloud organization the credentials belong to: its name and
 * whether services may collect core dumps. Only the settings you declare
 * change.
 *
 * The organization always exists and is never created or deleted. Alchemy
 * records the settings it finds on first deploy and puts them back on
 * destroy. It is also what the organization bindings
 * (`ListActivities`, `ListOrganizationQuotas`,
 * `GetOrganizationPrometheusDiscovery`, …) bind to.
 * @see https://clickhouse.com/docs/cloud/manage/openapi
 *
 * ### Configuring the Organization
 * **Example:** Rename the organization
 * ```typescript
 * const org = yield* ClickHouseCloud.Organization.Organization("Org", {
 *   name: "Acme Analytics",
 * });
 * ```
 *
 * **Example:** Allow core dumps
 * ```typescript
 * const org = yield* ClickHouseCloud.Organization.Organization("Org", {
 *   enableCoreDumps: true,
 * });
 * ```
 *
 * ### Reading the Audit Log from a Runtime
 * **Example:** Bind the organization and list today's activity
 * ```typescript
 * export const Org = ClickHouseCloud.Organization.Organization("Org", {});
 *
 * export default class Audit extends Cloudflare.Worker<Audit>()(
 *   "Audit",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const listActivities = yield* ClickHouseCloud.Organization.ListActivities(Org);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const activities = yield* listActivities({ from_date: "2026-11-12T00:00:00Z" });
 *         return yield* HttpServerResponse.json(activities);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Organization.ListActivitiesHttp)),
 * ) {}
 * ```
 *
 * @resource
 * @product Organization
 */
export const Organization = Resource<Organization>("ClickHouseCloud.Organization.Organization");

const toAttributes = (
  org: organization.Organization,
  organizationId: string,
  original: OrganizationOriginal,
): OrganizationAttributes => ({
  organizationId: org.id ?? organizationId,
  name: org.name ?? "",
  createdAt: org.createdAt,
  enableCoreDumps: org.enableCoreDumps,
  privateEndpoints: (org.privateEndpoints ?? []).map((p) => ({
    id: p.id,
    description: p.description,
    cloudProvider: p.cloudProvider,
    region: p.region,
  })),
  byocInfrastructureIds: (org.byocConfig ?? []).flatMap((b) => (b.id === undefined ? [] : [b.id])),
  snapshots: org.capabilities?.snapshots,
  original,
});

const getOrganization = (organizationId: string) =>
  organization
    .getOrganization({ organizationId })
    .pipe(Effect.flatMap(requireResult("getOrganization")));

/** Send only the declared settings that differ from the organization. */
const apply = Effect.fn(function* (
  organizationId: string,
  observed: organization.Organization,
  want: { name?: string | undefined; enableCoreDumps?: boolean | undefined },
) {
  const patch = {
    ...(want.name !== undefined && want.name !== observed.name ? { name: want.name } : {}),
    ...(want.enableCoreDumps !== undefined && want.enableCoreDumps !== observed.enableCoreDumps
      ? { enableCoreDumps: want.enableCoreDumps }
      : {}),
  };
  if (Object.keys(patch).length === 0) return observed;
  return yield* organization
    .updateOrganization({ organizationId, ...patch })
    .pipe(Effect.flatMap(requireResult("updateOrganization")));
});

export const OrganizationProvider = () =>
  Provider.effect(
    Organization,
    Effect.succeed({
      stables: ["organizationId", "createdAt", "original"],
      nuke: { singleton: true },
      list: () => Effect.succeed([]),
      read: Effect.fn(function* ({ output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const org = yield* getOrganization(organizationId);
        return toAttributes(
          org,
          organizationId,
          output?.original ?? { name: org.name, enableCoreDumps: org.enableCoreDumps },
        );
      }),
      reconcile: Effect.fn(function* ({ news, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        // Observe; the first observation is what destroy restores.
        const observed = yield* getOrganization(organizationId);
        const original = output?.original ?? {
          name: observed.name,
          enableCoreDumps: observed.enableCoreDumps,
        };
        // Sync only what is declared, against observed settings.
        const updated = yield* apply(organizationId, observed, news);
        return toAttributes(updated, organizationId, original);
      }),
      delete: Effect.fn(function* ({ output }) {
        const observed = yield* getOrganization(output.organizationId);
        yield* apply(output.organizationId, observed, output.original);
      }),
    }),
  );
