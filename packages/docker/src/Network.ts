import { OwnedBySomeoneElse, Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { createInternalTags, hasAlchemyTags, stripInternalTags } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Net from "effect/net";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Docker, dockerEngineContextName, dockerPhysicalName } from "./Docker.ts";
import type { Providers } from "./Providers.ts";

/** Address allocation settings for one Docker network subnet. */
export interface NetworkIpamConfig {
  /** IPv4 or IPv6 CIDR network prefix, without host bits. */
  subnet: string;
  /** Gateway address in the subnet's address family. Docker chooses one when omitted. */
  gateway?: string;
  /** CIDR sub-range from which Docker allocates container addresses. */
  ipRange?: string;
  /** Map of reservation names to IP addresses in the subnet's address family. */
  auxAddresses?: Record<string, string>;
}

/** Docker network IP Address Management (IPAM) configuration. */
export interface NetworkIpam {
  /** IPAM driver. @default "default" */
  driver?: string;
  /** IPAM driver-specific key/value options. */
  options?: Record<string, string>;
  /**
   * Subnet configurations. Docker allocates a subnet automatically when omitted;
   * drivers differ in how many explicit subnet entries they accept.
   */
  config?: NetworkIpamConfig[];
}

export interface NetworkProps {
  /**
   * Docker network name.
   *
   * @default Generated from stack, stage, logical id, and instance id.
   */
  name?: string;
  /** Network driver. @default "bridge" */
  driver?: "bridge" | "host" | "none" | "overlay" | "macvlan" | (string & {});
  /**
   * Restrict external connectivity through this network. Containers connected
   * to other networks can still have an external route.
   * @default false
   */
  internal?: boolean;
  /** Allow standalone containers to attach to an overlay network. @default false */
  attachable?: boolean;
  /** Enable IPv4 address allocation. Explicit `false` requires IPv6. @default true */
  enableIPv4?: boolean;
  /** Enable IPv6 on the network. @default false */
  enableIPv6?: boolean;
  /** Network-driver-specific key/value options, as passed to Docker `--opt`. */
  driverOpts?: Record<string, string>;
  /** Explicit IPAM configuration. Docker allocates missing subnet/gateway values. */
  ipam?: NetworkIpam;
  /** User labels. The `alchemy::*` prefix is reserved for resource ownership. */
  labels?: Record<string, string>;
  /**
   * The engine the network is created on: a Docker context name, a
   * `Docker.Context` resource, or a `Docker.Swarm` — overlay networks
   * require a swarm manager, and passing the swarm orders the network after
   * the swarm is initialized.
   */
  context?: Docker.EngineRef;
}

export interface Network extends Resource<
  "Docker.Network",
  NetworkProps,
  {
    /** Docker network ID. */
    id: string;
    /** Docker network name. */
    name: string;
    /** Network driver. */
    driver: string;
    /** Whether the network is isolated from external connectivity. */
    internal: boolean;
    /** Whether manual container attachment is allowed. */
    attachable: boolean;
    /** Whether IPv4 address allocation is enabled. */
    enableIPv4: boolean;
    /** Whether IPv6 is enabled. */
    enableIPv6: boolean;
    /** Driver options reported by Docker. */
    driverOpts: Record<string, string>;
    /** IPAM configuration reported by Docker (including automatically allocated values). */
    ipam: {
      driver: string;
      options: Record<string, string>;
      config: NetworkIpamConfig[];
    };
    /** Labels reported by Docker. */
    labels: Record<string, string>;
    /** Creation timestamp in milliseconds since epoch. */
    createdAt: number;
  },
  never,
  Providers,
  NetworkLookup
> {}

/**
 * Props for {@link Network.lookup}: find a network this stack
 * doesn't manage by its name.
 */
export interface NetworkLookup {
  /** Network name. */
  name: string;
  /**
   * Docker context the engine is reached through.
   * @default the current context
   */
  context?: string;
}

/**
 * A Docker network managed through the active Docker context.
 *
 * Existing same-name networks are treated as foreign unless the engine is
 * explicitly allowed to adopt them with `--adopt` or `adopt(true)`.
 *
 * ### Creating Networks
 * **Example:** Basic bridge network
 * ```typescript
 * const network = yield* Docker.Network("app-network", {
 *   name: "app-network",
 * });
 * ```
 *
 * ### Isolation and address allocation
 * **Example:** Internal bridge network with an explicit subnet and driver option
 * ```typescript
 * const network = yield* Docker.Network("private-network", {
 *   internal: true,
 *   attachable: true,
 *   enableIPv4: true,
 *   driverOpts: { "com.docker.network.driver.mtu": "1420" },
 *   ipam: {
 *     config: [{
 *       subnet: "10.50.0.0/24",
 *       gateway: "10.50.0.1",
 *       ipRange: "10.50.0.128/25",
 *       auxAddresses: { reserved: "10.50.0.5" },
 *     }],
 *   },
 * });
 * ```
 *
 * An internal network restricts external connectivity through that network;
 * additional container network attachments can still provide external routes.
 * If IPAM is omitted, Docker allocates a subnet and gateway. Alchemy does not
 * treat those automatically assigned values as configuration drift.
 * IPAM subnet and range values must be valid CIDR network prefixes (for
 * example, `10.50.0.0/24`, not `10.50.0.1/24`). Declared IPv4/IPv6 subnets
 * require the corresponding address family to be enabled. Alchemy validates
 * address containment and overlapping subnets before a destructive replacement,
 * and compares IPv6 addresses by their network value rather than text.
 * Invalid options fail with `InvalidNetworkOptions`, whose `path` identifies
 * the rejected field (for example, `ipam.config[0].gateway`).
 * Labels beginning with `alchemy::` are reserved for resource ownership and
 * cannot be overridden by user-supplied labels.
 *
 * ### IPv6-only networks
 * **Example:** Disable IPv4 address allocation
 * ```typescript
 * const network = yield* Docker.Network("ipv6-only", {
 *   enableIPv4: false,
 *   enableIPv6: true,
 * });
 * ```
 *
 * ### Dual-stack networks
 * **Example:** Allocate addresses from both families on a bridge network
 * ```typescript
 * const network = yield* Docker.Network("dual-stack", {
 *   enableIPv6: true,
 *   ipam: {
 *     config: [
 *       { subnet: "10.51.0.0/24", gateway: "10.51.0.1" },
 *       { subnet: "fd51:3456:789a::/64", gateway: "fd51:3456:789a::1" },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Driver-specific IPAM options
 * **Example:** Pass IPAM driver-specific settings
 * ```typescript
 * const network = yield* Docker.Network("ipam-network", {
 *   ipam: {
 *     driver: "default",
 *     options: { "my-option": "my-value" },
 *   },
 * });
 * ```
 *
 * Network driver and IPAM driver options are passed to Docker without
 * interpreting driver-specific semantics.
 *
 * ### Adoption
 * **Example:** Adopt a pre-existing network
 * ```typescript
 * const network = yield* Docker.Network("app-network", {
 *   name: "shared-app-network",
 * }).pipe(adopt(true));
 * ```
 *
 * ### Looking up an existing network
 * `Network.lookup` references a network Alchemy doesn't manage (created with
 * the Docker CLI, Compose or another stack). It is read during plan/deploy,
 * never created, updated or removed.
 *
 * **Example:** Attach a container to an existing network
 * ```typescript
 * const shared = Docker.Network.lookup({ name: "compose_default" });
 * const api = yield* Docker.Container("Api", {
 *   image: "nginx:alpine",
 *   networks: [{ name: shared.name }],
 * });
 * ```
 *
 * ### Replacement
 * Network creation settings are immutable. Changing them replaces the network.
 * Docker refuses to delete a network while it has attached endpoints; Alchemy
 * does not forcibly disconnect unrelated containers to complete replacement.
 * A managed network deleted outside Alchemy is recreated on the next deploy.
 * If another network takes over its name, Alchemy refuses to claim it: the
 * recorded Docker ID must still match, even if the network's settings do.
 * Replacement is not transactional: a custom network or IPAM driver may reject
 * a configuration after Docker has already removed the old network. Alchemy
 * validates known IPAM constraints ahead of time, but the network driver
 * determines which settings take effect. Some drivers may accept options
 * without applying them; inspect the resulting network for advanced settings.
 *
 * ### Swarm overlay allocation
 * Docker Swarm can return an overlay network ID before its driver and IPAM
 * are available. Alchemy waits for both before recording the network. If
 * allocation does not finish within the inspection limit, deploy fails
 * instead of saving incomplete attributes. Retry once the network is ready.
 *
 * If a previous deploy saved incomplete attributes, the next deploy refreshes
 * them in place when the live Docker ID and settings match. The network's
 * name stays stable for attached services. Changing immutable network
 * settings still requires replacement.
 *
 * @resource
 * @product Network
 */
export const Network = Resource<Network>("Docker.Network");

export const NetworkProvider = () =>
  Provider.effect(
    Network,
    Effect.gen(function* () {
      const docker = yield* Docker;

      return Network.Provider.of({
        list: () => Effect.succeed([]),
        lookup: Effect.fn(function* ({ name, context }) {
          const info = yield* docker.network
            .inspect(name, context)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
          return info ? toNetworkAttributes(info) : undefined;
        }),

        read: Effect.fn(function* ({ id, instanceId, olds, output }) {
          const context = dockerEngineContextName(olds?.context);
          const name = yield* networkName(id, olds, instanceId);
          const info = yield* docker.network
            .inspect(name, context)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
          if (!info) return undefined;
          // A different network may have taken over the same name after the
          // managed network was removed out of band. Never silently adopt it.
          // Without prior state, only adopt a network that carries our branding.
          const owned = output
            ? output.id === info.Id
            : yield* hasAlchemyTags(id, info.Labels ?? undefined);
          if (!owned) return Unowned(toNetworkAttributes(info));
          return toNetworkAttributes(
            olds?.driver === "overlay" || info.Driver === "overlay"
              ? yield* waitForOverlayAllocation(docker, info, context)
              : info,
          );
        }),
        diff: Effect.fn(function* ({ id, output, instanceId, news, olds }) {
          if (!isResolved(news) || !output) return undefined;
          const args = yield* makeNetworkArgs(id, news, instanceId);
          if (dockerEngineContextName(olds?.context) !== dockerEngineContextName(news?.context)) {
            return { action: "replace", deleteFirst: true };
          }
          const inspectCurrent = Effect.gen(function* () {
            const current = yield* docker.network
              .inspect(output.name, dockerEngineContextName(olds?.context))
              .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
            if (current && current.Id !== output.id) {
              return yield* new OwnedBySomeoneElse({
                message:
                  `Network '${output.name}' was replaced outside Alchemy: ` +
                  `expected Docker ID ${output.id}, found ${current.Id}. ` +
                  "Choose a different name or explicitly resolve the ownership conflict.",
                resourceType: "Docker.Network",
                logicalId: id,
                physicalName: output.name,
              });
            }
            return current;
          });

          // Older deploys could persist Swarm's pre-allocation inspect result.
          // Compare the same live network instead of replacing it for blank attributes.
          const incompleteOverlay = hasIncompleteOverlayState(olds, output);
          let observed = output;
          if (incompleteOverlay) {
            const current = yield* inspectCurrent;
            if (!current) return { action: "update" };
            observed = toNetworkAttributes(
              yield* waitForOverlayAllocation(
                docker,
                current,
                dockerEngineContextName(olds?.context),
              ),
            );
          }

          // Auto-generated names are engine-owned: the deployed name stays
          // authoritative even if the generator would name this id differently
          // today. Only an explicit user-provided name can force a replace.
          const desiredName = news?.name ?? observed.name;
          if (
            observed.name !== desiredName ||
            observed.driver !== args.driver ||
            (observed.internal ?? false) !== (args.internal ?? false) ||
            (observed.attachable ?? false) !== (args.attachable ?? false) ||
            (observed.enableIPv4 ?? true) !== (args.ipv4 ?? true) ||
            observed.enableIPv6 !== args.ipv6 ||
            !matchesOptions(observed.driverOpts ?? {}, args.opt ?? {}) ||
            hasRemovedOptions(olds?.driverOpts, news?.driverOpts) ||
            !matchesIpam(
              observed.ipam ?? { driver: "default", options: {}, config: [] },
              news?.ipam,
              olds?.ipam,
            ) ||
            // Compare only user labels; internal `alchemy::*` branding lives on
            // the observed network but must not drive replacement.
            !Equal.equals(stripInternalTags(observed.labels), args.label ?? {})
          ) {
            return { action: "replace", deleteFirst: true };
          }
          // Repair only the stored attributes, not consumers of the network's name.
          if (incompleteOverlay) return { action: "update", stables: ["name"] };
          // Recreate a missing network without trying to delete its former generation.
          if (!(yield* inspectCurrent)) return { action: "update" };
        }),
        reconcile: Effect.fn(function* ({ output, id, instanceId, news, olds }) {
          const context = dockerEngineContextName(news?.context);
          const args = yield* makeNetworkArgs(id, news, instanceId);
          if (output) {
            const refreshed = yield* docker.network
              .inspect(output.id, context)
              .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined));
            if (refreshed) {
              return toNetworkAttributes(
                args.driver === "overlay"
                  ? yield* waitForOverlayAllocation(docker, refreshed, context)
                  : refreshed,
              );
            }
          }
          const internalTags = yield* createInternalTags(id);
          const { stdout: createdId } = yield* docker.network.create({
            ...args,
            // A repaired overlay can disappear between plan and apply. Recreate it
            // under the same name when no explicit rename was requested.
            name:
              output && hasIncompleteOverlayState(olds, output)
                ? (news?.name ?? output.name)
                : args.name,
            label: { ...args.label, ...internalTags },
            context,
          });
          const created = yield* docker.network.inspect(createdId, context);
          return toNetworkAttributes(
            args.driver === "overlay"
              ? yield* waitForOverlayAllocation(docker, created, context)
              : created,
          );
        }),
        delete: Effect.fn(({ olds, output }) =>
          docker.network
            .remove(output.id, dockerEngineContextName(olds?.context))
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void)),
        ),
      });
    }),
  );

/** Swarm may return a network ID before its driver and IPAM have been allocated. */
class OverlayNetworkNotReady extends Data.TaggedError("OverlayNetworkNotReady")<{
  readonly message: string;
}> {}

const hasIncompleteOverlayState = (
  props: NetworkProps | undefined,
  output: Network["Attributes"],
) => props?.driver === "overlay" && (output.driver === "" || output.ipam?.driver === "");

const overlayAllocationPending = (info: Docker.Network) =>
  info.Driver === "" || (info.Driver === "overlay" && !info.IPAM?.Driver);

const waitForOverlayAllocation = Effect.fn(function* (
  docker: Docker["Service"],
  initial: Docker.Network,
  context?: string,
) {
  if (!overlayAllocationPending(initial)) return initial;
  const info = yield* docker.network.inspect(initial.Id, context).pipe(
    Effect.repeat({
      until: (info) => !overlayAllocationPending(info),
      schedule: Schedule.spaced("250 millis"),
      times: 7,
    }),
  );
  if (overlayAllocationPending(info)) {
    return yield* new OverlayNetworkNotReady({
      message: `Swarm did not allocate overlay network '${info.Name}' (${info.Id}) before the inspection limit. Retry once the network is ready.`,
    });
  }
  return info;
});

/**
 * Swarm (overlay) network names are capped at 63 characters, like service
 * names; other drivers accept much longer ones. An overlay network over the
 * cap could never be created, so capping it renames nothing.
 */
const networkName = (id: string, props: NetworkProps | undefined, instanceId: string) =>
  dockerPhysicalName(id, props, instanceId, props?.driver === "overlay" ? 63 : undefined);

/** Invalid user-supplied network settings, detected before Docker is called. */
export class InvalidNetworkOptions extends Data.TaggedError("InvalidNetworkOptions")<{
  /** Property path in the declared Docker.Network configuration. */
  readonly path: string;
  /** Human-readable reason for rejecting the network configuration. */
  readonly message: string;
}> {}

const invalidNetworkOption = (path: string, detail: string) =>
  Effect.fail(new InvalidNetworkOptions({ path, message: `Docker.Network ${path}: ${detail}` }));

const invalidMapEntry = (entries: Record<string, string> | undefined) =>
  Object.entries(entries ?? {}).find(
    ([key, value]) => !key.trim() || key.includes("=") || !value.trim(),
  );

// Effect's network schemas reject CIDRs with host bits set and normalize
// equivalent IPv6 spellings. Use the same semantics for input validation and
// observed-state comparisons rather than maintaining a second IP parser.
const parseNetwork = Schema.decodeUnknownResult(Schema.IpNetworkFromString);
const parseIpAddress = Schema.decodeUnknownResult(Schema.IpAddressFromString);

const sameNetwork = (left: string, right: string) => {
  const a = parseNetwork(left);
  const b = parseNetwork(right);
  return Result.isSuccess(a) && Result.isSuccess(b) && Equal.equals(a.success, b.success);
};

const sameIpAddress = (left: string, right: string) => {
  const a = parseIpAddress(left);
  const b = parseIpAddress(right);
  return Result.isSuccess(a) && Result.isSuccess(b) && Equal.equals(a.success, b.success);
};

const validateNetworkOptions = (props: NetworkProps | undefined) => {
  if (props?.enableIPv4 === false && props.enableIPv6 !== true) {
    return invalidNetworkOption("enableIPv4", "disabling IPv4 requires enableIPv6=true");
  }
  const reservedLabel = Object.keys(props?.labels ?? {}).find((key) => key.startsWith("alchemy::"));
  if (reservedLabel !== undefined) {
    return invalidNetworkOption(
      `labels[${JSON.stringify(reservedLabel)}]`,
      "the alchemy:: label prefix is reserved for resource ownership",
    );
  }
  for (const [path, entries] of [
    ["driverOpts", props?.driverOpts],
    ["ipam.options", props?.ipam?.options],
  ] as const) {
    const invalid = invalidMapEntry(entries);
    if (invalid) {
      return invalidNetworkOption(
        `${path}[${JSON.stringify(invalid[0])}]`,
        "option names must be nonempty and exclude '=', and values must be nonempty",
      );
    }
  }
  if (props?.ipam?.driver !== undefined && !props.ipam.driver.trim()) {
    return invalidNetworkOption("ipam.driver", "driver cannot be empty");
  }
  const subnets: Net.IpNetwork.IpNetwork[] = [];
  for (const [index, entry] of (props?.ipam?.config ?? []).entries()) {
    const path = `ipam.config[${index}]`;
    const subnet = parseNetwork(entry.subnet);
    if (Result.isFailure(subnet)) {
      return invalidNetworkOption(`${path}.subnet`, subnet.failure.message);
    }
    if (Net.IpNetwork.isIpv4Network(subnet.success) && props?.enableIPv4 === false) {
      return invalidNetworkOption(
        `${path}.subnet`,
        `IPv4 subnet ${entry.subnet} requires enableIPv4 to be enabled`,
      );
    }
    if (Net.IpNetwork.isIpv6Network(subnet.success) && props?.enableIPv6 !== true) {
      return invalidNetworkOption(
        `${path}.subnet`,
        `IPv6 subnet ${entry.subnet} requires enableIPv6=true`,
      );
    }
    const overlapping = subnets.findIndex((previous) =>
      Net.IpNetwork.overlaps(previous, subnet.success),
    );
    if (overlapping !== -1) {
      return invalidNetworkOption(
        `${path}.subnet`,
        `subnet ${entry.subnet} overlaps ipam.config[${overlapping}].subnet`,
      );
    }
    subnets.push(subnet.success);
    if (entry.gateway !== undefined) {
      const gateway = parseIpAddress(entry.gateway);
      if (Result.isFailure(gateway)) {
        return invalidNetworkOption(`${path}.gateway`, gateway.failure.message);
      }
      if (!Net.IpNetwork.contains(subnet.success, gateway.success)) {
        return invalidNetworkOption(
          `${path}.gateway`,
          `gateway ${entry.gateway} must be inside subnet ${entry.subnet}`,
        );
      }
    }
    if (entry.ipRange !== undefined) {
      const range = parseNetwork(entry.ipRange);
      if (Result.isFailure(range)) {
        return invalidNetworkOption(`${path}.ipRange`, range.failure.message);
      }
      if (!Net.IpNetwork.containsNetwork(subnet.success, range.success)) {
        return invalidNetworkOption(
          `${path}.ipRange`,
          `range ${entry.ipRange} must be inside subnet ${entry.subnet}`,
        );
      }
    }
    const invalidAux = invalidMapEntry(entry.auxAddresses);
    if (invalidAux) {
      return invalidNetworkOption(
        `${path}.auxAddresses[${JSON.stringify(invalidAux[0])}]`,
        "reservation names must be nonempty and exclude '=', and addresses must be nonempty",
      );
    }
    for (const [name, address] of Object.entries(entry.auxAddresses ?? {})) {
      const auxPath = `${path}.auxAddresses[${JSON.stringify(name)}]`;
      const reserved = parseIpAddress(address);
      if (Result.isFailure(reserved)) {
        return invalidNetworkOption(auxPath, reserved.failure.message);
      }
      if (!Net.IpNetwork.contains(subnet.success, reserved.success)) {
        return invalidNetworkOption(
          auxPath,
          `address ${address} must be inside subnet ${entry.subnet}`,
        );
      }
    }
  }
  return Effect.void;
};

const makeNetworkArgs = (id: string, props: NetworkProps | undefined, instanceId: string) =>
  networkName(id, props, instanceId).pipe(
    Effect.tap(() => validateNetworkOptions(props)),
    Effect.map((name): Parameters<Docker["Service"]["network"]["create"]>[0] => ({
      name,
      driver: props?.driver ?? "bridge",
      internal: props?.internal,
      attachable: props?.attachable,
      ipv4: props?.enableIPv4,
      ipv6: props?.enableIPv6 ?? false,
      opt: props?.driverOpts,
      ipam: props?.ipam,
      label: props?.labels ?? {},
    })),
  );

const matchesOptions = (actual: Record<string, string>, desired: Record<string, string>) =>
  Object.entries(desired).every(([key, value]) => actual[key] === value);

const hasRemovedOptions = (
  previous: Record<string, string> | undefined,
  current: Record<string, string> | undefined,
) => Object.keys(previous ?? {}).some((key) => !(key in (current ?? {})));

const matchesIpam = (
  observed: Network["Attributes"]["ipam"],
  desired: NetworkIpam | undefined,
  previous: NetworkIpam | undefined,
) => {
  if (desired?.driver !== undefined && observed.driver !== desired.driver) return false;
  if (previous?.driver !== undefined && desired?.driver === undefined) return false;
  if (!matchesOptions(observed.options, desired?.options ?? {})) return false;
  if (hasRemovedOptions(previous?.options, desired?.options)) return false;
  const config = desired?.config ?? [];
  for (const entry of config) {
    const live = observed.config.find((item) => sameNetwork(item.subnet, entry.subnet));
    if (
      !live ||
      (entry.gateway !== undefined &&
        (live.gateway === undefined || !sameIpAddress(live.gateway, entry.gateway))) ||
      (entry.ipRange !== undefined &&
        (live.ipRange === undefined || !sameNetwork(live.ipRange, entry.ipRange))) ||
      !Object.entries(entry.auxAddresses ?? {}).every(
        ([key, value]) =>
          live.auxAddresses?.[key] !== undefined && sameIpAddress(live.auxAddresses[key], value),
      )
    ) {
      return false;
    }
  }
  // Docker auto-allocates IPAM entries when config is omitted. Compare only
  // explicitly declared entries, but detect removal of formerly managed ones.
  for (const old of previous?.config ?? []) {
    const now = config.find((item) => sameNetwork(item.subnet, old.subnet));
    if (
      !now ||
      (old.gateway !== undefined && now.gateway === undefined) ||
      (old.ipRange !== undefined && now.ipRange === undefined) ||
      hasRemovedOptions(old.auxAddresses, now.auxAddresses)
    ) {
      return false;
    }
  }
  return true;
};

export const toNetworkAttributes = (info: Docker.Network): Network["Attributes"] => ({
  id: info.Id,
  name: info.Name,
  driver: info.Driver,
  internal: info.Internal ?? false,
  attachable: info.Attachable ?? false,
  enableIPv4: info.EnableIPv4 ?? true,
  enableIPv6: info.EnableIPv6,
  driverOpts: info.Options ?? {},
  ipam: {
    driver: info.IPAM?.Driver ?? "default",
    options: info.IPAM?.Options ?? {},
    config: (info.IPAM?.Config ?? []).map((entry) => ({
      subnet: entry.Subnet,
      gateway: entry.Gateway,
      ipRange: entry.IPRange,
      auxAddresses: entry.AuxiliaryAddresses ?? {},
    })),
  },
  labels: info.Labels ?? {},
  createdAt: Date.parse(info.Created) || Date.now(),
});
