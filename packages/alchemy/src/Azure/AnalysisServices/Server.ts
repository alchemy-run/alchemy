import * as analysisservices from "@distilled.cloud/azure/analysisservices";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/**
 * Analysis Services SKU: `D1` (Development), `B1`/`B2` (Basic), or
 * `S0`–`S9` (Standard).
 */
export type AnalysisServicesSkuName =
  | "D1"
  | "B1"
  | "B2"
  | "S0"
  | "S1"
  | "S2"
  | "S4"
  | "S8"
  | "S9"
  | "S8v2"
  | "S9v2"
  | (string & {});

/** One IPv4 range allowed through the server firewall. */
export interface AnalysisServicesFirewallRule {
  /** Name of the rule. */
  name: string;
  /** First IPv4 address of the range. */
  rangeStart: string;
  /** Last IPv4 address of the range. */
  rangeEnd: string;
}

/** IPv4 firewall settings of an Analysis Services server. */
export interface AnalysisServicesFirewall {
  /**
   * Allowed IPv4 ranges. When the firewall is set, only these ranges (and
   * Power BI, if enabled) can connect.
   * @default []
   */
  rules?: AnalysisServicesFirewallRule[];
  /**
   * Allow the Power BI service through the firewall.
   * @default false
   */
  enablePowerBIService?: boolean;
}

export interface ServerProps {
  /**
   * Resource group the server is created in. Changing it replaces the
   * server.
   */
  resourceGroup: string;
  /**
   * Server name: 3-63 lowercase letters and digits, starting with a letter.
   * Unique per region. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the server.
   */
  name?: string;
  /**
   * Azure location of the server. Changing it replaces the server.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Pricing SKU. Moving between the Development tier (`D1`) and the
   * Basic/Standard tiers may be rejected by Azure.
   * @default "D1"
   */
  sku?: AnalysisServicesSkuName;
  /**
   * Number of query replicas (scale-out). Only Standard SKUs support more
   * than one.
   * @default Azure's default (`1`)
   */
  capacity?: number;
  /**
   * Server administrators: Entra user principal names (`user@contoso.com`),
   * or service principals as `app:{appId}@{tenantId}`.
   * @default []
   */
  administrators?: string[];
  /**
   * SAS URI of a blob container used for backups. Treat it as a secret.
   */
  backupBlobContainerUri?: string;
  /**
   * Resource ID of an on-premises data gateway to associate with the server.
   */
  gatewayResourceId?: string;
  /**
   * IPv4 firewall. When omitted, the firewall is left as Azure configures
   * it (open).
   */
  firewall?: AnalysisServicesFirewall;
  /**
   * Whether the read-write server serves queries (`All`) or only processes
   * (`ReadOnly`). `ReadOnly` requires `capacity` greater than 1.
   * @default Azure's default (`All`)
   */
  querypoolConnectionMode?: "All" | "ReadOnly";
  /**
   * Managed mode of the server (`0` = not managed, `1` = managed).
   */
  managedMode?: 0 | 1;
  /**
   * Server monitor mode (`0` = off, `1` = on).
   */
  serverMonitorMode?: 0 | 1;
  /**
   * Suspend the server. A paused server is not billed for compute and does
   * not accept queries.
   * @default false
   */
  paused?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Server extends Resource<
  "Azure.AnalysisServices.Server",
  ServerProps,
  {
    /** Name of the server. */
    serverName: string;
    /** ARM resource ID of the server. */
    serverId: string;
    /** Resource group that holds the server. */
    resourceGroup: string;
    /** Location of the server. */
    location: string;
    /**
     * Connection name clients use, e.g.
     * `asazure://eastus.asazure.windows.net/{name}`.
     */
    serverFullName: string;
    /** Pricing SKU. */
    sku: string;
    /** Pricing tier (`Development`, `Basic`, or `Standard`). */
    tier: string | undefined;
    /** Number of query replicas. */
    capacity: number | undefined;
    /** Current server state, e.g. `Succeeded` or `Paused`. */
    state: string | undefined;
    /** Server administrators. */
    administrators: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Analysis Services server — a managed tabular-model (SSAS)
 * engine that Power BI, Excel, and other clients query over
 * `asazure://` connections.
 *
 * @see https://learn.microsoft.com/azure/analysis-services/analysis-services-overview
 *
 * ### Creating a Server
 * **Example:** Development server with a service-principal admin
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("analytics");
 * const server = yield* Azure.AnalysisServices.Server("models", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "D1",
 *   administrators: ["app:00000000-0000-0000-0000-000000000000@contoso.com"],
 * });
 * ```
 *
 * ### Restricting Access
 * **Example:** Firewall that allows one office range and Power BI
 * ```typescript
 * const server = yield* Azure.AnalysisServices.Server("models", {
 *   resourceGroup: group.resourceGroupName,
 *   firewall: {
 *     enablePowerBIService: true,
 *     rules: [
 *       { name: "office", rangeStart: "203.0.113.0", rangeEnd: "203.0.113.255" },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Saving Cost
 * **Example:** Suspend a server while it is not needed
 * ```typescript
 * const server = yield* Azure.AnalysisServices.Server("models", {
 *   resourceGroup: group.resourceGroupName,
 *   paused: true,
 * });
 * ```
 *
 * @resource
 */
export const Server = Resource<Server>("Azure.AnalysisServices.Server");

type ObservedServer = analysisservices.GetServerDetailsResponse;

const createServerName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 63,
    lowercase: true,
    delimiter: "",
  });
  const cleaned = name.replace(/[^a-z0-9]/g, "");
  return /^[a-z]/.test(cleaned) ? cleaned : `as${cleaned}`.slice(0, 63);
});

const getServer = (
  subscriptionId: string,
  resourceGroupName: string,
  serverName: string,
) =>
  orUndefinedIfNotFound(
    analysisservices.GetServerDetails({
      subscriptionId,
      resourceGroupName,
      serverName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  server: ObservedServer,
): Server["Attributes"] => ({
  serverName: name,
  serverId: server.id ?? "",
  resourceGroup,
  location: server.location,
  serverFullName: server.properties?.serverFullName ?? "",
  sku: server.sku?.name ?? "",
  tier: server.sku?.tier,
  capacity: server.sku?.capacity,
  state: server.properties?.state,
  administrators: [...(server.properties?.asAdministrators?.members ?? [])],
  tags: userTags(server.tags),
});

const lower = (value: string | undefined) => value?.toLowerCase();

const sameMembers = (
  observed: ReadonlyArray<string> | undefined,
  desired: ReadonlyArray<string>,
) => {
  const a = [...(observed ?? [])].map((m) => m.toLowerCase()).sort();
  const b = [...desired].map((m) => m.toLowerCase()).sort();
  return a.length === b.length && a.every((m, i) => m === b[i]);
};

const toFirewallSettings = (
  firewall: AnalysisServicesFirewall,
): analysisservices.IPv4FirewallSettings => ({
  firewallRules: (firewall.rules ?? []).map((rule) => ({
    firewallRuleName: rule.name,
    rangeStart: rule.rangeStart,
    rangeEnd: rule.rangeEnd,
  })),
  enablePowerBIService: firewall.enablePowerBIService ?? false,
});

const firewallKey = (
  settings: analysisservices.IPv4FirewallSettings | undefined,
) =>
  JSON.stringify({
    rules: [...(settings?.firewallRules ?? [])]
      .map((r) => [r.firewallRuleName ?? "", r.rangeStart, r.rangeEnd])
      .sort(),
    powerBi: settings?.enablePowerBIService ?? false,
  });

/** Server states that settle on their own; wait them out before acting. */
const TRANSITIONAL = new Set([
  "Provisioning",
  "Updating",
  "Suspending",
  "Pausing",
  "Resuming",
  "Preparing",
  "Scaling",
  "Deleting",
]);

export const ServerProvider = () =>
  Provider.succeed(Server, {
    stables: ["serverName", "serverId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // ListServers has no nextLink: the API returns every server in one page.
      const page = yield* analysisservices.ListServers({ subscriptionId });
      return (page.value ?? []).flatMap((server) => {
        const group = resourceGroupOf(server.id);
        return hasAnyAlchemyTag(server.tags) &&
          group !== undefined &&
          server.name !== undefined
          ? [toAttrs(group, server.name, server as ObservedServer)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const nameChanged =
        news.name !== undefined && news.name !== output.serverName;
      if (
        nameChanged ||
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.location !== undefined &&
          lower(news.location)?.replace(/\s/g, "") !==
            lower(output.location)?.replace(/\s/g, ""))
      ) {
        // A generated name changes with the replacement's instance ID. An
        // explicit name is kept, and server names are unique per region (and
        // the ARM ID is shared within one resource group), so the old server
        // must be deleted first.
        return news.name !== undefined && !nameChanged
          ? ({ action: "replace", deleteFirst: true } as const)
          : ({ action: "replace" } as const);
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.serverName ?? olds?.name ?? (yield* createServerName(id));
      const observed = yield* getServer(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.AnalysisServices");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.serverName ?? (yield* createServerName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const skuName = news.sku ?? "D1";
      const administrators = news.administrators ?? [];
      const paused = news.paused ?? false;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        serverName: name,
      };
      const label = `analysis services server ${name}`;
      const get = getServer(subscriptionId, resourceGroup, name);
      // Wait until the server settles in a stable (running or paused) state.
      const settle = waitForProvisioned(
        label,
        get,
        (server) => {
          const state = server.properties?.state;
          if (state === "Failed") return "Failed";
          return state !== undefined && TRANSITIONAL.has(state)
            ? state
            : "Succeeded";
        },
        { interval: "5 seconds", times: 120 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* analysisservices.CreateServer({
          ...where,
          location,
          sku: {
            name: skuName,
            ...(news.capacity !== undefined ? { capacity: news.capacity } : {}),
          },
          tags,
          properties: {
            asAdministrators: { members: administrators },
            backupBlobContainerUri: news.backupBlobContainerUri,
            gatewayDetails:
              news.gatewayResourceId !== undefined
                ? { gatewayResourceId: news.gatewayResourceId }
                : undefined,
            ipV4FirewallSettings:
              news.firewall !== undefined
                ? toFirewallSettings(news.firewall)
                : undefined,
            querypoolConnectionMode: news.querypoolConnectionMode,
            managedMode: news.managedMode,
            serverMonitorMode: news.serverMonitorMode,
          },
        });
      }
      observed = yield* settle;

      // A paused server rejects updates: resume it before syncing.
      if (observed.properties?.state === "Paused") {
        yield* analysisservices.ResumeServer(where);
        observed = yield* settle;
      }

      // Sync mutable aspects against observed state; PATCH only deltas.
      const props = observed.properties ?? {};
      const changed: analysisservices.AnalysisServicesServerMutablePropertiesInput =
        {};
      if (!sameMembers(props.asAdministrators?.members, administrators)) {
        changed.asAdministrators = { members: administrators };
      }
      if (
        news.backupBlobContainerUri !== undefined &&
        props.backupBlobContainerUri !== news.backupBlobContainerUri
      ) {
        changed.backupBlobContainerUri = news.backupBlobContainerUri;
      }
      if (
        news.gatewayResourceId !== undefined &&
        lower(props.gatewayDetails?.gatewayResourceId) !==
          lower(news.gatewayResourceId)
      ) {
        changed.gatewayDetails = { gatewayResourceId: news.gatewayResourceId };
      }
      if (news.firewall !== undefined) {
        const desiredFirewall = toFirewallSettings(news.firewall);
        if (
          firewallKey(props.ipV4FirewallSettings) !==
          firewallKey(desiredFirewall)
        ) {
          changed.ipV4FirewallSettings = desiredFirewall;
        }
      }
      if (
        news.querypoolConnectionMode !== undefined &&
        props.querypoolConnectionMode !== news.querypoolConnectionMode
      ) {
        changed.querypoolConnectionMode = news.querypoolConnectionMode;
      }
      if (
        news.managedMode !== undefined &&
        props.managedMode !== news.managedMode
      ) {
        changed.managedMode = news.managedMode;
      }
      if (
        news.serverMonitorMode !== undefined &&
        props.serverMonitorMode !== news.serverMonitorMode
      ) {
        changed.serverMonitorMode = news.serverMonitorMode;
      }
      const skuChanged =
        observed.sku?.name !== skuName ||
        (news.capacity !== undefined &&
          observed.sku?.capacity !== news.capacity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(changed).length > 0 || skuChanged || tagsChanged) {
        yield* analysisservices.UpdateServer({
          ...where,
          sku: skuChanged
            ? {
                name: skuName,
                ...(news.capacity !== undefined
                  ? { capacity: news.capacity }
                  : {}),
              }
            : undefined,
          tags: tagsChanged ? tags : undefined,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
        });
        observed = yield* settle;
      }

      if (paused && observed.properties?.state !== "Paused") {
        yield* analysisservices.SuspendServer(where);
        observed = yield* settle;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        serverName: output.serverName,
      };
      yield* ignoreNotFound(analysisservices.DeleteServer(where));
      yield* waitUntilGone(
        `analysis services server ${output.serverName}`,
        getServer(subscriptionId, output.resourceGroup, output.serverName),
        { interval: "5 seconds", times: 120 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
