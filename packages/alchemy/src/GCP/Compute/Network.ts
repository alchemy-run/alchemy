import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitGlobalOperations } from "./operations.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";

export type NetworkProps = {
  /**
   * Network name. If omitted, a unique RFC1035 name is generated from the
   * stack, stage, and logical id. Must be 1-63 characters and match
   * `[a-z]([-a-z0-9]*[a-z0-9])?`.
   */
  networkName?: string;
  /**
   * User description. Immutable — changing it replaces the network.
   * Alchemy ownership labels are stamped into the description (VPC networks
   * have no `labels` field) so `list` / nuke can find the resource.
   */
  description?: string;
  /**
   * When `true`, GCP creates a subnet in every region (auto mode). When
   * `false`, the VPC is custom mode and you add subnets yourself. Immutable
   * — changing it replaces the network.
   * @default false
   */
  autoCreateSubnetworks?: boolean;
  /**
   * Maximum transmission unit in bytes (1300–8896).
   * @default 1460
   */
  mtu?: number;
  /**
   * Network-wide Cloud Router advertisement mode.
   * @default "REGIONAL"
   */
  routingMode?: compute.NetworkRoutingConfigRoutingModeEnum;
  /**
   * BGP best-path selection algorithm (`LEGACY` or `STANDARD`).
   */
  bgpBestPathSelectionMode?: compute.NetworkRoutingConfigBgpBestPathSelectionModeEnum;
  /**
   * Compare MED across routes with different neighbor ASNs (STANDARD BGP).
   */
  bgpAlwaysCompareMed?: boolean;
  /**
   * Inter-region cost handling for STANDARD BGP (`DEFAULT` or
   * `ADD_COST_TO_MED`).
   */
  bgpInterRegionCost?: compute.NetworkRoutingConfigBgpInterRegionCostEnum;
  /**
   * When to enforce hierarchical firewall policies relative to classic
   * VPC firewall rules.
   * @default "AFTER_CLASSIC_FIREWALL"
   */
  networkFirewallPolicyEnforcementOrder?: compute.NetworkNetworkFirewallPolicyEnforcementOrderEnum;
  /**
   * Enable ULA internal IPv6 (`fd20::/20`). Immutable — changing it
   * replaces the network.
   * @default false
   */
  enableUlaInternalIpv6?: boolean;
  /**
   * Optional `/48` from `fd20::/20` used when ULA IPv6 is enabled.
   * Immutable — changing it replaces the network.
   */
  internalIpv6Range?: string;
  /**
   * Full or partial URL of a network profile. Set only at create time.
   * Immutable — changing it replaces the network.
   */
  networkProfile?: string;
};

export type Network = Resource<
  "GCP.Compute.Network",
  NetworkProps,
  {
    /** RFC1035 network name. */
    networkName: string;
    /** Server-assigned numeric id. */
    networkId: string | undefined;
    /** Project id. */
    project: string;
    /** Server-defined resource URL. */
    selfLink: string | undefined;
    /** Server-defined URL including the numeric id. */
    selfLinkWithId: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Whether auto-mode subnets were created. */
    autoCreateSubnetworks: boolean;
    /** User description (Alchemy ownership marker stripped). */
    description: string | undefined;
    /** Configured MTU in bytes. */
    mtu: number | undefined;
    /** Network-wide routing mode. */
    routingMode: string | undefined;
    /** BGP best-path selection mode. */
    bgpBestPathSelectionMode: string | undefined;
    /** Whether MED is compared across neighbor ASNs. */
    bgpAlwaysCompareMed: boolean | undefined;
    /** Inter-region cost handling for STANDARD BGP. */
    bgpInterRegionCost: string | undefined;
    /** Hierarchical firewall policy enforcement order. */
    networkFirewallPolicyEnforcementOrder: string | undefined;
    /** Whether ULA internal IPv6 is enabled. */
    enableUlaInternalIpv6: boolean;
    /** Allocated ULA `/48`, if any. */
    internalIpv6Range: string | undefined;
    /** Network profile URL, if any. */
    networkProfile: string | undefined;
    /** Gateway address selected by Google Cloud. */
    gatewayIPv4: string | undefined;
    /** Associated firewall policy URL, if any. */
    firewallPolicy: string | undefined;
    /** Subnetwork self-links. */
    subnetworks: ReadonlyArray<string> | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Compute Engine VPC network.
 *
 * VPC networks have no `labels` field. Alchemy stamps
 * `alchemy-stack` / `alchemy-stage` / `alchemy-id` into the description so
 * `list` and `pnpm nuke:gcp` can still identify owned networks.
 *
 * ### Creating a Network
 * **Example:** Custom-mode VPC (generated name)
 * ```typescript
 * const network = yield* GCP.Compute.Network("Vpc", {});
 * ```
 *
 * **Example:** Explicit name, MTU, and routing mode
 * ```typescript
 * const network = yield* GCP.Compute.Network("Vpc", {
 *   networkName: "app-vpc",
 *   description: "application vpc",
 *   autoCreateSubnetworks: false,
 *   mtu: 1500,
 *   routingMode: "GLOBAL",
 * });
 * ```
 *
 * ### Auto-mode VPC
 * **Example:** Auto-create a subnet in every region
 * ```typescript
 * const network = yield* GCP.Compute.Network("Vpc", {
 *   autoCreateSubnetworks: true,
 * });
 * ```
 *
 * Auto mode is slower to create and delete (one subnet per region). Prefer
 * custom mode (`autoCreateSubnetworks: false`, the default) unless you
 * specifically want the pre-created ranges.
 *
 * @resource
 * @product GCP
 * @category Compute
 */
export const Network = Resource<Network>("GCP.Compute.Network");

export class NetworkNotResolved extends Data.TaggedError(
  "GCP.Compute.NetworkNotResolved",
)<{
  networkName: string;
}> {}

export class NetworkOperationFailed extends Data.TaggedError(
  "GCP.Compute.NetworkOperationFailed",
)<{
  operation: string;
  errors: ReadonlyArray<{ code?: string; message?: string }>;
}> {}

const DEFAULT_AUTO_CREATE = false;
const DEFAULT_MTU = 1460;
const DEFAULT_ROUTING_MODE = "REGIONAL";
const DEFAULT_ENFORCEMENT = "AFTER_CLASSIC_FIREWALL";

const OWNERSHIP_KEYS = [
  "alchemy-stack",
  "alchemy-stage",
  "alchemy-id",
] as const;

const encodeDescription = (
  internal: Record<string, string>,
  user?: string,
): string => {
  const marker = OWNERSHIP_KEYS.map(
    (key) => `${key}=${internal[key] ?? ""}`,
  ).join(" ");
  return user && user.length > 0 ? `${marker}\n${user}` : marker;
};

const parseDescription = (description: string | undefined) => {
  if (!description) {
    return { labels: {} as Record<string, string>, description: undefined };
  }
  const newline = description.indexOf("\n");
  const first = newline === -1 ? description : description.slice(0, newline);
  const rest = newline === -1 ? undefined : description.slice(newline + 1);
  if (!first.includes("alchemy-id=") || !first.includes("alchemy-stack=")) {
    return { labels: {} as Record<string, string>, description };
  }
  const labels: Record<string, string> = {};
  for (const part of first.split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  return {
    labels,
    description: rest && rest.length > 0 ? rest : undefined,
  };
};

const hasAlchemyMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const toNetworkName = (
  id: string,
  name: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: 63,
      lowercase: true,
    });
    const rfc = generated
      .replace(/^[^a-z]+/, "n")
      .slice(0, 63)
      .replace(/-+$/g, "");
    return rfc.length > 0 ? rfc : "n";
  });

const toAttrs = (
  network: compute.Network,
  project: string,
): Network["Attributes"] => {
  const parsed = parseDescription(network.description);
  return {
    networkName: network.name ?? "",
    networkId: network.id,
    project,
    selfLink: network.selfLink,
    selfLinkWithId: network.selfLinkWithId,
    creationTimestamp: network.creationTimestamp,
    autoCreateSubnetworks: network.autoCreateSubnetworks === true,
    description: parsed.description,
    mtu: network.mtu,
    routingMode: network.routingConfig?.routingMode,
    bgpBestPathSelectionMode: network.routingConfig?.bgpBestPathSelectionMode,
    bgpAlwaysCompareMed: network.routingConfig?.bgpAlwaysCompareMed,
    bgpInterRegionCost: network.routingConfig?.bgpInterRegionCost,
    networkFirewallPolicyEnforcementOrder:
      network.networkFirewallPolicyEnforcementOrder,
    enableUlaInternalIpv6: network.enableUlaInternalIpv6 === true,
    internalIpv6Range: network.internalIpv6Range,
    networkProfile: network.networkProfile,
    gatewayIPv4: network.gatewayIPv4,
    firewallPolicy: network.firewallPolicy,
    subnetworks: network.subnetworks,
  };
};

const getByName = (project: string, networkName: string) =>
  compute
    .getNetworks({ project, network: networkName })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const isNotFoundOp = (
  errors: ReadonlyArray<{ code?: string; message?: string }>,
) =>
  errors.length > 0 &&
  errors.every((error) => {
    const code = (error.code ?? "").toLowerCase();
    const message = (error.message ?? "").toLowerCase();
    return (
      code === "notfound" ||
      code === "resource_not_found" ||
      message.includes("was not found") ||
      message.includes("not found")
    );
  });

const isInUseOp = (
  errors: ReadonlyArray<{ code?: string; message?: string }>,
) =>
  errors.some((error) => {
    const code = (error.code ?? "").toLowerCase();
    const message = (error.message ?? "").toLowerCase();
    return (
      code.includes("resource_in_use") ||
      code.includes("resourceinusebyanotherresource") ||
      message.includes("is used by") ||
      message.includes("in use")
    );
  });

const assertOperationOk = (operation: compute.Operation) => {
  const errors = operation.error?.errors ?? [];
  const status = operation.httpErrorStatusCode;
  if (
    (errors.length === 0 && (status === undefined || status < 400)) ||
    isNotFoundOp(errors)
  ) {
    return Effect.void;
  }
  return Effect.fail(
    new NetworkOperationFailed({
      operation: operation.name ?? "",
      errors: errors.map((error) => ({
        code: error.code,
        message: error.message,
      })),
    }),
  );
};

const waitForGlobalOperation = (
  project: string,
  operation: compute.Operation,
) =>
  Effect.gen(function* () {
    const name = operation.name;
    if (!name) {
      if (operation.status === "DONE") {
        yield* assertOperationOk(operation);
        return;
      }
      return yield* new NetworkOperationFailed({
        operation: "",
        errors: [{ message: "compute operation is missing a name" }],
      });
    }
    if (operation.status === "DONE") {
      yield* assertOperationOk(operation);
      return;
    }
    const waited = yield* waitGlobalOperations(
      { project, operation: name },
      { times: 20 },
    ).pipe(
      Effect.catchTag("GCP.Compute.OperationPending", (error) =>
        Effect.fail(
          new NetworkOperationFailed({
            operation: name,
            errors: [
              {
                message: `Timed out waiting for operation (status=${error.status})`,
              },
            ],
          }),
        ),
      ),
    );
    yield* assertOperationOk(waited);
  });

const requireNetwork = (project: string, networkName: string) =>
  getByName(project, networkName).pipe(
    Effect.flatMap((network) =>
      network
        ? Effect.succeed(network)
        : Effect.fail(new NetworkNotResolved({ networkName })),
    ),
    Effect.retry({
      while: (e) => e._tag === "GCP.Compute.NetworkNotResolved",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );

export const NetworkProvider = () =>
  Provider.succeed(Network, {
    stables: [
      "networkName",
      "networkId",
      "project",
      "selfLink",
      "selfLinkWithId",
      "creationTimestamp",
      "autoCreateSubnetworks",
      "enableUlaInternalIpv6",
      "internalIpv6Range",
      "networkProfile",
      "gatewayIPv4",
      "description",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds?.networkName ?? output?.networkName;
      const nextName = news.networkName ?? previousName;
      const replace =
        (previousName !== undefined &&
          news.networkName !== undefined &&
          news.networkName !== previousName) ||
        (olds?.autoCreateSubnetworks ??
          output?.autoCreateSubnetworks ??
          DEFAULT_AUTO_CREATE) !==
          (news.autoCreateSubnetworks ?? DEFAULT_AUTO_CREATE) ||
        (olds?.enableUlaInternalIpv6 ??
          output?.enableUlaInternalIpv6 ??
          false) !== (news.enableUlaInternalIpv6 ?? false) ||
        (news.internalIpv6Range !== undefined &&
          (olds?.internalIpv6Range ?? output?.internalIpv6Range) !==
            news.internalIpv6Range) ||
        (news.networkProfile !== undefined &&
          (olds?.networkProfile ?? output?.networkProfile) !==
            news.networkProfile) ||
        (news.description !== undefined &&
          (olds?.description ?? output?.description ?? "") !==
            news.description);
      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          nextName !== undefined &&
          previousName !== undefined &&
          nextName === previousName,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const networkName = yield* toNetworkName(
        id,
        olds?.networkName,
        output?.networkName,
      );
      const existing = yield* getByName(env.project, networkName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const parsed = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, parsed.labels))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listNetworks
          .items({ project: env.project, maxResults: 500 })
          .pipe(
            Stream.filter((network) => hasAlchemyMarker(network.description)),
            Stream.map((network) => toAttrs(network, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const networkName = yield* toNetworkName(
        id,
        news.networkName,
        output?.networkName,
      );
      const autoCreateSubnetworks =
        news.autoCreateSubnetworks ?? DEFAULT_AUTO_CREATE;
      const mtu = news.mtu ?? DEFAULT_MTU;
      const routingMode = news.routingMode ?? DEFAULT_ROUTING_MODE;
      const enforcement =
        news.networkFirewallPolicyEnforcementOrder ?? DEFAULT_ENFORCEMENT;
      const enableUlaInternalIpv6 = news.enableUlaInternalIpv6 === true;
      const internal = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(internal, news.description);

      let current = yield* getByName(env.project, networkName);

      if (current === undefined) {
        const routingConfig: compute.NetworkRoutingConfig = {
          routingMode,
        };
        if (news.bgpBestPathSelectionMode !== undefined) {
          routingConfig.bgpBestPathSelectionMode =
            news.bgpBestPathSelectionMode;
        }
        if (news.bgpAlwaysCompareMed !== undefined) {
          routingConfig.bgpAlwaysCompareMed = news.bgpAlwaysCompareMed;
        }
        if (news.bgpInterRegionCost !== undefined) {
          routingConfig.bgpInterRegionCost = news.bgpInterRegionCost;
        }
        const body: compute.Network = {
          name: networkName,
          autoCreateSubnetworks,
          description: desiredDescription,
          mtu,
          routingConfig,
          networkFirewallPolicyEnforcementOrder: enforcement,
        };
        if (enableUlaInternalIpv6) {
          body.enableUlaInternalIpv6 = true;
        }
        if (news.internalIpv6Range !== undefined) {
          body.internalIpv6Range = news.internalIpv6Range;
        }
        if (news.networkProfile !== undefined) {
          body.networkProfile = news.networkProfile;
        }
        const inserted = yield* compute
          .insertNetworks({
            project: env.project,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (inserted !== undefined) {
          yield* waitForGlobalOperation(env.project, inserted);
        }
        current = yield* requireNetwork(env.project, networkName);
      }

      if (current === undefined) {
        return yield* new NetworkNotResolved({ networkName });
      }

      const applyPatch = (body: compute.Network) =>
        Effect.gen(function* () {
          const patched = yield* compute.patchNetworks({
            project: env.project,
            network: networkName,
            body,
          });
          yield* waitForGlobalOperation(env.project, patched);
          return yield* requireNetwork(env.project, networkName);
        });

      // GCP rejects PATCH bodies that combine an MTU change with any other
      // field ("Other fields cannot be modified when changing MTU").
      if ((current.mtu ?? DEFAULT_MTU) !== mtu) {
        current = yield* applyPatch({ mtu });
      }

      const patchBody: compute.Network = {};
      if (
        (current.networkFirewallPolicyEnforcementOrder ??
          DEFAULT_ENFORCEMENT) !== enforcement
      ) {
        patchBody.networkFirewallPolicyEnforcementOrder = enforcement;
      }
      const routingPatch: compute.NetworkRoutingConfig = {};
      if (
        (current.routingConfig?.routingMode ?? DEFAULT_ROUTING_MODE) !==
        routingMode
      ) {
        routingPatch.routingMode = routingMode;
      }
      if (
        news.bgpBestPathSelectionMode !== undefined &&
        current.routingConfig?.bgpBestPathSelectionMode !==
          news.bgpBestPathSelectionMode
      ) {
        routingPatch.bgpBestPathSelectionMode = news.bgpBestPathSelectionMode;
      }
      if (
        news.bgpAlwaysCompareMed !== undefined &&
        current.routingConfig?.bgpAlwaysCompareMed !== news.bgpAlwaysCompareMed
      ) {
        routingPatch.bgpAlwaysCompareMed = news.bgpAlwaysCompareMed;
      }
      if (
        news.bgpInterRegionCost !== undefined &&
        current.routingConfig?.bgpInterRegionCost !== news.bgpInterRegionCost
      ) {
        routingPatch.bgpInterRegionCost = news.bgpInterRegionCost;
      }
      if (Object.keys(routingPatch).length > 0) {
        patchBody.routingConfig = routingPatch;
      }

      if (Object.keys(patchBody).length > 0) {
        current = yield* applyPatch(patchBody);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      if (!output.networkName) return;
      yield* compute
        .deleteNetworks({
          project: env.project,
          network: output.networkName,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitForGlobalOperation(env.project, operation),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (error) =>
              error._tag === "Conflict" ||
              (error._tag === "GCP.Compute.NetworkOperationFailed" &&
                isInUseOp(error.errors)),
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
    }),
  });
