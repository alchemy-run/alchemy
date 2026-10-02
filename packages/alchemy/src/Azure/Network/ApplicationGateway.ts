import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  canonical,
  createNetworkName,
  lower,
  nameOf,
  sameId,
  sameSet,
  waitNetworkGoneSlow,
  waitNetworkProvisionedSlow,
  whileNetworkBusy,
} from "./common.ts";

export interface ApplicationGatewayFrontendIpConfiguration {
  /** Name of the frontend, referenced by `httpListeners[].frontendIpConfiguration`. */
  name: string;
  /** ARM ID of a Standard static public IP (public frontend). */
  publicIpAddressId?: string;
  /** ARM ID of the gateway subnet (private frontend). */
  subnetId?: string;
  /** Static private IP in the gateway subnet (private frontend). */
  privateIpAddress?: string;
}

export interface ApplicationGatewayFrontendPort {
  /** Name of the port, referenced by `httpListeners[].frontendPort`. */
  name: string;
  /** Port number, e.g. `80`. */
  port: number;
}

export interface ApplicationGatewayBackendAddressPool {
  /** Name of the pool, referenced by `requestRoutingRules[].backendAddressPool`. */
  name: string;
  /** Backend host names, e.g. `app.azurewebsites.net`. */
  fqdns?: string[];
  /** Backend IP addresses. */
  ipAddresses?: string[];
}

export interface ApplicationGatewayProbe {
  /** Name of the probe, referenced by `backendHttpSettings[].probe`. */
  name: string;
  /** Probe protocol. */
  protocol: "Http" | "Https";
  /** Path probed, e.g. `/health`. */
  path: string;
  /**
   * Host header sent with the probe. Leave unset with
   * `pickHostNameFromBackendHttpSettings`.
   */
  host?: string;
  /**
   * Use the host name of the backend HTTP settings.
   * @default false
   */
  pickHostNameFromBackendHttpSettings?: boolean;
  /**
   * Seconds between probes.
   * @default 30
   */
  interval?: number;
  /**
   * Probe timeout in seconds.
   * @default 30
   */
  timeout?: number;
  /**
   * Failed probes before a backend is marked unhealthy.
   * @default 3
   */
  unhealthyThreshold?: number;
}

export interface ApplicationGatewayBackendHttpSettings {
  /** Name of the settings, referenced by `requestRoutingRules[].backendHttpSettings`. */
  name: string;
  /** Backend port, e.g. `80` or `443`. */
  port: number;
  /** Backend protocol. */
  protocol: "Http" | "Https";
  /**
   * Cookie-based session affinity.
   * @default "Disabled"
   */
  cookieBasedAffinity?: "Enabled" | "Disabled";
  /**
   * Request timeout in seconds (1-86400).
   * @default 30
   */
  requestTimeout?: number;
  /** Host header sent to the backend. */
  hostName?: string;
  /**
   * Send the backend address's host name as the host header (App Service
   * backends).
   * @default false
   */
  pickHostNameFromBackendAddress?: boolean;
  /** Name of the custom probe (from `probes`). */
  probe?: string;
}

export interface ApplicationGatewayHttpListener {
  /** Name of the listener, referenced by `requestRoutingRules[].httpListener`. */
  name: string;
  /** Name of the frontend IP configuration. */
  frontendIpConfiguration: string;
  /** Name of the frontend port. */
  frontendPort: string;
  /** Host names for multi-site listeners. Unset for a basic listener. */
  hostNames?: string[];
}

export interface ApplicationGatewayRequestRoutingRule {
  /** Name of the rule. */
  name: string;
  /** Priority between 1 and 20000 (lower wins); unique per gateway. */
  priority: number;
  /** Name of the HTTP listener. */
  httpListener: string;
  /** Name of the backend address pool. */
  backendAddressPool: string;
  /** Name of the backend HTTP settings. */
  backendHttpSettings: string;
}

export interface ApplicationGatewayProps {
  /**
   * Resource group the gateway is created in. Changing it replaces the
   * gateway.
   */
  resourceGroup: string;
  /**
   * Name of the gateway: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the gateway.
   */
  name?: string;
  /**
   * Azure location of the gateway (same as its virtual network). Changing
   * it replaces the gateway.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Availability zones, e.g. `["1", "2", "3"]`. Changing them replaces the gateway. */
  zones?: string[];
  /**
   * SKU. `Basic` is the low-cost tier (no autoscale, no WAF); `WAF_v2` adds
   * the web application firewall.
   * @default "Standard_v2"
   */
  sku?: "Basic" | "Standard_v2" | "WAF_v2";
  /**
   * Fixed instance count. Set either `capacity` or `autoscale`.
   * @default 1 (when `autoscale` is unset)
   */
  capacity?: number;
  /** Autoscale bounds (v2 SKUs). */
  autoscale?: { minCapacity: number; maxCapacity?: number };
  /**
   * ARM ID of the dedicated gateway subnet (no other resource types).
   * Changing it replaces the gateway.
   */
  subnetId: string;
  /** Frontend IP configurations (one public and/or one private). */
  frontendIpConfigurations: ApplicationGatewayFrontendIpConfiguration[];
  /** Frontend ports. */
  frontendPorts: ApplicationGatewayFrontendPort[];
  /** Backend address pools. */
  backendAddressPools: ApplicationGatewayBackendAddressPool[];
  /** Backend HTTP settings. */
  backendHttpSettings: ApplicationGatewayBackendHttpSettings[];
  /** Custom health probes. */
  probes?: ApplicationGatewayProbe[];
  /** HTTP listeners. HTTPS listeners (TLS certificates) are not modelled. */
  httpListeners: ApplicationGatewayHttpListener[];
  /** Basic request routing rules (listener -> pool + settings). */
  requestRoutingRules: ApplicationGatewayRequestRoutingRule[];
  /** ARM ID of a WAF policy (`WAF_v2` only). */
  firewallPolicyId?: string;
  /**
   * Enable HTTP/2 for clients.
   * @default false
   */
  enableHttp2?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ApplicationGateway extends Resource<
  "Azure.Network.ApplicationGateway",
  ApplicationGatewayProps,
  {
    /** Name of the gateway. */
    applicationGatewayName: string;
    /** ARM resource ID of the gateway. */
    applicationGatewayId: string;
    /** Resource group that holds the gateway. */
    resourceGroup: string;
    /** Location of the gateway. */
    location: string;
    /** SKU name. */
    sku: string | undefined;
    /** Operational state (`Running`, `Stopped`, ...). */
    operationalState: string | undefined;
    /** Private frontend IP addresses. */
    privateIpAddresses: string[];
    /** Public IP address IDs of the frontends. */
    publicIpAddressIds: string[];
    /** Availability zones. */
    zones: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Application Gateway (v2) — a regional layer-7 load balancer
 * with path/host routing, health probes, and an optional web application
 * firewall.
 *
 * Sub-objects (frontends, ports, pools, settings, probes, listeners, rules)
 * reference each other by name; the provider expands the names into the
 * ARM sub-resource IDs. The gateway needs a dedicated subnet and, for a
 * public frontend, a Standard static public IP. Provisioning and deletion
 * take 5-15 minutes. TLS listeners, URL path maps, rewrites, and redirects
 * are not modelled yet.
 *
 * @see https://learn.microsoft.com/azure/application-gateway/overview-v2
 *
 * ### Creating an Application Gateway
 * **Example:** Public HTTP gateway in front of a web app
 * ```typescript
 * const subnet = yield* Azure.Network.Subnet("appgw-subnet", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.0.0/24",
 * });
 * const ip = yield* Azure.Network.PublicIpAddress("appgw-ip", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const gateway = yield* Azure.Network.ApplicationGateway("appgw", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Basic",
 *   subnetId: subnet.subnetId,
 *   frontendIpConfigurations: [
 *     { name: "public", publicIpAddressId: ip.publicIpAddressId },
 *   ],
 *   frontendPorts: [{ name: "http", port: 80 }],
 *   backendAddressPools: [{ name: "web", fqdns: ["app.azurewebsites.net"] }],
 *   backendHttpSettings: [
 *     {
 *       name: "https",
 *       port: 443,
 *       protocol: "Https",
 *       pickHostNameFromBackendAddress: true,
 *     },
 *   ],
 *   httpListeners: [
 *     { name: "http", frontendIpConfiguration: "public", frontendPort: "http" },
 *   ],
 *   requestRoutingRules: [
 *     {
 *       name: "web",
 *       priority: 100,
 *       httpListener: "http",
 *       backendAddressPool: "web",
 *       backendHttpSettings: "https",
 *     },
 *   ],
 * });
 * ```
 *
 * ### Scaling
 * **Example:** Autoscaling Standard_v2 gateway
 * ```typescript
 * const gateway = yield* Azure.Network.ApplicationGateway("appgw", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Standard_v2",
 *   autoscale: { minCapacity: 0, maxCapacity: 3 },
 *   subnetId: subnet.subnetId,
 *   frontendIpConfigurations,
 *   frontendPorts,
 *   backendAddressPools,
 *   backendHttpSettings,
 *   httpListeners,
 *   requestRoutingRules,
 * });
 * ```
 *
 * @resource
 */
export const ApplicationGateway = Resource<ApplicationGateway>(
  "Azure.Network.ApplicationGateway",
);

type Observed = network.GetApplicationGatewayResponse;

const getGateway = (
  subscriptionId: string,
  resourceGroupName: string,
  applicationGatewayName: string,
) =>
  orUndefinedIfNotFound(
    network.GetApplicationGateway({
      subscriptionId,
      resourceGroupName,
      applicationGatewayName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  gateway: Observed,
): ApplicationGateway["Attributes"] => {
  const frontends = gateway.properties?.frontendIPConfigurations ?? [];
  return {
    applicationGatewayName: name,
    applicationGatewayId: gateway.id ?? "",
    resourceGroup,
    location: gateway.location ?? "",
    sku: gateway.properties?.sku?.name,
    operationalState: gateway.properties?.operationalState,
    privateIpAddresses: frontends.flatMap((f) =>
      f.properties?.privateIPAddress ? [f.properties.privateIPAddress] : [],
    ),
    publicIpAddressIds: frontends.flatMap((f) =>
      f.properties?.publicIPAddress?.id
        ? [f.properties.publicIPAddress.id]
        : [],
    ),
    zones: [...(gateway.zones ?? [])],
    tags: userTags(gateway.tags),
  };
};

/** The gateway's ARM properties, built from the props (names -> IDs). */
const desiredProperties = (
  news: ApplicationGatewayProps,
  gatewayId: string,
) => {
  const sub = (collection: string, name: string) => ({
    id: `${gatewayId}/${collection}/${name}`,
  });
  const sku = news.sku ?? "Standard_v2";
  return {
    sku: {
      name: sku,
      tier: sku,
      capacity: news.autoscale === undefined ? (news.capacity ?? 1) : undefined,
    },
    autoscaleConfiguration: news.autoscale,
    gatewayIPConfigurations: [
      { name: "gateway", properties: { subnet: { id: news.subnetId } } },
    ],
    frontendIPConfigurations: news.frontendIpConfigurations.map((f) => ({
      name: f.name,
      properties: {
        publicIPAddress:
          f.publicIpAddressId === undefined
            ? undefined
            : { id: f.publicIpAddressId },
        subnet: f.subnetId === undefined ? undefined : { id: f.subnetId },
        privateIPAddress: f.privateIpAddress,
        privateIPAllocationMethod:
          f.privateIpAddress === undefined ? undefined : "Static",
      },
    })),
    frontendPorts: news.frontendPorts.map((p) => ({
      name: p.name,
      properties: { port: p.port },
    })),
    backendAddressPools: news.backendAddressPools.map((pool) => ({
      name: pool.name,
      properties: {
        backendAddresses: [
          ...(pool.fqdns ?? []).map((fqdn) => ({ fqdn })),
          ...(pool.ipAddresses ?? []).map((ipAddress) => ({ ipAddress })),
        ],
      },
    })),
    probes: (news.probes ?? []).map((probe) => ({
      name: probe.name,
      properties: {
        protocol: probe.protocol,
        path: probe.path,
        host: probe.host,
        pickHostNameFromBackendHttpSettings:
          probe.pickHostNameFromBackendHttpSettings ?? false,
        interval: probe.interval ?? 30,
        timeout: probe.timeout ?? 30,
        unhealthyThreshold: probe.unhealthyThreshold ?? 3,
      },
    })),
    backendHttpSettingsCollection: news.backendHttpSettings.map((s) => ({
      name: s.name,
      properties: {
        port: s.port,
        protocol: s.protocol,
        cookieBasedAffinity: s.cookieBasedAffinity ?? "Disabled",
        requestTimeout: s.requestTimeout ?? 30,
        hostName: s.hostName,
        pickHostNameFromBackendAddress:
          s.pickHostNameFromBackendAddress ?? false,
        probe: s.probe === undefined ? undefined : sub("probes", s.probe),
      },
    })),
    httpListeners: news.httpListeners.map((l) => ({
      name: l.name,
      properties: {
        frontendIPConfiguration: sub(
          "frontendIPConfigurations",
          l.frontendIpConfiguration,
        ),
        frontendPort: sub("frontendPorts", l.frontendPort),
        protocol: "Http",
        hostNames: l.hostNames,
      },
    })),
    requestRoutingRules: news.requestRoutingRules.map((r) => ({
      name: r.name,
      properties: {
        ruleType: "Basic",
        priority: r.priority,
        httpListener: sub("httpListeners", r.httpListener),
        backendAddressPool: sub("backendAddressPools", r.backendAddressPool),
        backendHttpSettings: sub(
          "backendHttpSettingsCollection",
          r.backendHttpSettings,
        ),
      },
    })),
    firewallPolicy:
      news.firewallPolicyId === undefined
        ? undefined
        : { id: news.firewallPolicyId },
    enableHttp2: news.enableHttp2 ?? false,
  };
};

interface Ref {
  readonly id?: string;
}

/**
 * Comparable projection of the modelled configuration. Works on both the
 * desired body and the observed GET (same field names); sub-resource
 * references compare by name.
 */
const project = (p: {
  readonly sku?: { readonly name?: string; readonly capacity?: number };
  readonly autoscaleConfiguration?: {
    readonly minCapacity: number;
    readonly maxCapacity?: number;
  };
  readonly gatewayIPConfigurations?: ReadonlyArray<{
    readonly properties?: { readonly subnet?: Ref };
  }>;
  readonly frontendIPConfigurations?: ReadonlyArray<{
    readonly name?: string;
    readonly properties?: {
      readonly publicIPAddress?: Ref;
      readonly subnet?: Ref;
      readonly privateIPAddress?: string;
    };
  }>;
  readonly frontendPorts?: ReadonlyArray<{
    readonly name?: string;
    readonly properties?: { readonly port?: number };
  }>;
  readonly backendAddressPools?: ReadonlyArray<{
    readonly name?: string;
    readonly properties?: {
      readonly backendAddresses?: ReadonlyArray<{
        readonly fqdn?: string;
        readonly ipAddress?: string;
      }>;
    };
  }>;
  readonly probes?: ReadonlyArray<{
    readonly name?: string;
    readonly properties?: {
      readonly protocol?: string;
      readonly path?: string;
      readonly host?: string;
      readonly pickHostNameFromBackendHttpSettings?: boolean;
      readonly interval?: number;
      readonly timeout?: number;
      readonly unhealthyThreshold?: number;
    };
  }>;
  readonly backendHttpSettingsCollection?: ReadonlyArray<{
    readonly name?: string;
    readonly properties?: {
      readonly port?: number;
      readonly protocol?: string;
      readonly cookieBasedAffinity?: string;
      readonly requestTimeout?: number;
      readonly hostName?: string;
      readonly pickHostNameFromBackendAddress?: boolean;
      readonly probe?: Ref;
    };
  }>;
  readonly httpListeners?: ReadonlyArray<{
    readonly name?: string;
    readonly properties?: {
      readonly frontendIPConfiguration?: Ref;
      readonly frontendPort?: Ref;
      readonly hostNames?: ReadonlyArray<string>;
    };
  }>;
  readonly requestRoutingRules?: ReadonlyArray<{
    readonly name?: string;
    readonly properties?: {
      readonly priority?: number;
      readonly httpListener?: Ref;
      readonly backendAddressPool?: Ref;
      readonly backendHttpSettings?: Ref;
    };
  }>;
  readonly firewallPolicy?: Ref;
  readonly enableHttp2?: boolean;
}) => {
  const byName = <T extends { readonly name?: string }>(
    items: ReadonlyArray<T> | undefined,
  ) =>
    [...(items ?? [])].sort((a, b) =>
      (a.name ?? "").localeCompare(b.name ?? ""),
    );
  return canonical({
    sku: p.sku?.name,
    capacity: p.autoscaleConfiguration ? undefined : p.sku?.capacity,
    autoscale: p.autoscaleConfiguration && {
      min: p.autoscaleConfiguration.minCapacity,
      max: p.autoscaleConfiguration.maxCapacity,
    },
    subnet: lower(p.gatewayIPConfigurations?.[0]?.properties?.subnet?.id),
    frontends: byName(p.frontendIPConfigurations).map((f) => ({
      name: f.name,
      publicIp: lower(f.properties?.publicIPAddress?.id),
      subnet: f.properties?.privateIPAddress
        ? lower(f.properties.subnet?.id)
        : undefined,
      privateIp: f.properties?.privateIPAddress,
    })),
    ports: byName(p.frontendPorts).map((port) => ({
      name: port.name,
      port: port.properties?.port,
    })),
    pools: byName(p.backendAddressPools).map((pool) => ({
      name: pool.name,
      addresses: (pool.properties?.backendAddresses ?? [])
        .map((a) => a.fqdn ?? a.ipAddress ?? "")
        .sort(),
    })),
    probes: byName(p.probes).map((probe) => ({
      name: probe.name,
      protocol: probe.properties?.protocol,
      path: probe.properties?.path,
      host: probe.properties?.host,
      pickHost: probe.properties?.pickHostNameFromBackendHttpSettings,
      interval: probe.properties?.interval,
      timeout: probe.properties?.timeout,
      unhealthyThreshold: probe.properties?.unhealthyThreshold,
    })),
    settings: byName(p.backendHttpSettingsCollection).map((s) => ({
      name: s.name,
      port: s.properties?.port,
      protocol: s.properties?.protocol,
      affinity: s.properties?.cookieBasedAffinity,
      timeout: s.properties?.requestTimeout,
      hostName: s.properties?.hostName,
      pickHost: s.properties?.pickHostNameFromBackendAddress,
      probe: nameOf(s.properties?.probe?.id),
    })),
    listeners: byName(p.httpListeners).map((l) => ({
      name: l.name,
      frontend: nameOf(l.properties?.frontendIPConfiguration?.id),
      port: nameOf(l.properties?.frontendPort?.id),
      hostNames: [...(l.properties?.hostNames ?? [])].sort(),
    })),
    rules: byName(p.requestRoutingRules).map((r) => ({
      name: r.name,
      priority: r.properties?.priority,
      listener: nameOf(r.properties?.httpListener?.id),
      pool: nameOf(r.properties?.backendAddressPool?.id),
      settings: nameOf(r.properties?.backendHttpSettings?.id),
    })),
    firewallPolicy: lower(p.firewallPolicy?.id),
    http2: p.enableHttp2 ?? false,
  });
};

export const ApplicationGatewayProvider = () =>
  Provider.succeed(ApplicationGateway, {
    stables: [
      "applicationGatewayName",
      "applicationGatewayId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* network
        .ListApplicationGatewayAll({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListApplicationGatewayAll", page),
          ),
        );
      return page.value.flatMap((gateway) => {
        const group = resourceGroupOf(gateway.id);
        return hasAnyAlchemyTag(gateway.tags) &&
          group !== undefined &&
          gateway.name !== undefined
          ? [toAttrs(group, gateway.name, gateway)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameId(news.name, output.applicationGatewayName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
        !sameSet(news.zones, output.zones) ||
        (olds !== undefined && !sameId(news.subnetId, olds.subnetId))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.applicationGatewayName ??
        olds?.name ??
        (yield* createNetworkName(id));
      const observed = yield* getGateway(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.applicationGatewayName ??
        (yield* createNetworkName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        applicationGatewayName: name,
      };
      const label = `application gateway ${name}`;
      const get = getGateway(subscriptionId, resourceGroup, name);
      const gatewayId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/applicationGateways/${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure + sync: the configuration graph is one PUT; skip it when the
      // modelled configuration matches; a tags-only delta is a PATCH.
      const desired = desiredProperties(news, gatewayId);
      if (
        observed === undefined ||
        project(observed.properties ?? {}) !== project(desired)
      ) {
        yield* network
          .ApplicationGatewaysCreateOrUpdate({
            ...where,
            location,
            tags,
            zones: news.zones,
            properties: desired,
          })
          .pipe(Effect.retry(whileNetworkBusy));
      } else if (tagsDiffer(observed.tags, tags)) {
        yield* network
          .UpdateApplicationGatewayTags({ ...where, tags })
          .pipe(Effect.retry(whileNetworkBusy));
      }
      observed = yield* waitNetworkProvisionedSlow(label, get);
      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        network.DeleteApplicationGateway({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          applicationGatewayName: output.applicationGatewayName,
        }),
      ).pipe(Effect.retry(whileNetworkBusy));
      yield* waitNetworkGoneSlow(
        `application gateway ${output.applicationGatewayName}`,
        getGateway(
          subscriptionId,
          output.resourceGroup,
          output.applicationGatewayName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
