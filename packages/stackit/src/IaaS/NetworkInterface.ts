import * as iaas from "@distilled.cloud/stackit/iaas";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { waitUntilGone } from "../internal/wait.ts";
import { desiredLabels, hasAlchemyLabels, stripInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  findOwnedByName,
  iaasName,
  labelsPatch,
  ownedOnly,
  projectScopeChanged,
  resolveProjectScope,
  sameMembers,
  type ProjectScope,
} from "./internal.ts";

/** The create response of a network interface carried no id. */
export class NetworkInterfaceIdMissing extends Data.TaggedError(
  "Stackit.IaaS.NetworkInterfaceIdMissing",
)<{
  readonly resourceName: string;
  readonly message: string;
}> {}

export interface NetworkInterfaceProps {
  /** Network the interface is created in. Changing it replaces the interface. */
  networkId: string;
  /**
   * Project of the network. Defaults to the profile's project. Changing it
   * replaces the interface.
   */
  projectId?: string;
  /**
   * Region of the network. Defaults to the profile's region. Changing it
   * replaces the interface.
   */
  region?: string;
  /**
   * Interface name. Updated in place. If omitted, a unique name is
   * generated from the app, stage and logical id.
   */
  name?: string;
  /** Free-text description. Updated in place; not managed when omitted. */
  description?: string;
  /**
   * Fixed IPv4 address inside the network's prefix. When omitted, DHCP
   * assigns one. Changing it replaces the interface.
   */
  ipv4?: string;
  /**
   * Fixed IPv6 address inside the network's prefix. When omitted, one is
   * assigned. Changing it replaces the interface.
   */
  ipv6?: string;
  /**
   * Additional addresses or CIDRs the interface may send from (e.g. a
   * virtual IP shared by a high-availability pair). Updated in place; not
   * managed when omitted.
   */
  allowedAddresses?: string[];
  /**
   * Whether security groups and anti-spoofing apply to the interface.
   * With `false`, `securityGroups` must be empty. Updated in place.
   * @default true
   */
  nicSecurity?: boolean;
  /**
   * Security groups applied to the interface. Updated in place; when
   * omitted, the project's default group applies and the list is not
   * managed.
   */
  securityGroups?: string[];
  /**
   * User labels. Alchemy's ownership labels (`alchemy.stack`,
   * `alchemy.stage`, `alchemy.id`) are added automatically.
   */
  labels?: Record<string, string>;
}

export interface NetworkInterfaceAttributes {
  /** Network interface id (UUID). */
  networkInterfaceId: string;
  /** Network the interface belongs to. */
  networkId: string;
  /** Project of the network. */
  projectId: string;
  /** Region of the network. */
  region: string;
  /** Interface name. */
  name: string;
  /** Description, if any. */
  description: string | undefined;
  /** Assigned IPv4 address, if any. */
  ipv4: string | undefined;
  /** Assigned IPv6 address, if any. */
  ipv6: string | undefined;
  /** MAC address. */
  mac: string | undefined;
  /** Device (server) the interface is attached to, if any. */
  device: string | undefined;
  /** Allowed additional addresses. */
  allowedAddresses: string[];
  /** Whether security groups apply. */
  nicSecurity: boolean;
  /** Security groups applied to the interface. */
  securityGroups: string[];
  /** `ACTIVE` when attached and up, `DOWN` otherwise. */
  status: string | undefined;
  /** Interface type: `server`, `metadata`, `gateway` or `none`. */
  type: string | undefined;
  /** User labels (Alchemy's ownership labels stripped). */
  labels: Record<string, string>;
}

export type NetworkInterface = Resource<
  "Stackit.IaaS.NetworkInterface",
  NetworkInterfaceProps,
  NetworkInterfaceAttributes,
  never,
  Providers
>;

/**
 * A STACKIT network interface (NIC, a port): an address in a
 * {@link Network} with its own security groups, which a server attaches.
 * Create the interface up front to give a server a fixed address, to
 * associate a {@link PublicIp} with it, or to move it between servers.
 *
 * Name, description, allowed addresses, security settings and labels are
 * updated in place; the network and fixed addresses cannot change.
 *
 * ### Creating a network interface
 * **Example:** Interface with a fixed address
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const nic = yield* Stackit.IaaS.NetworkInterface("Web", {
 *   networkId: network.networkId,
 *   ipv4: "10.0.1.10",
 * });
 * ```
 *
 * ### Security groups
 * **Example:** Interface in a custom security group
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const web = yield* Stackit.IaaS.SecurityGroup("Web", {});
 * const nic = yield* Stackit.IaaS.NetworkInterface("Web", {
 *   networkId: network.networkId,
 *   securityGroups: [web.securityGroupId],
 * });
 * ```
 *
 * **Example:** Router interface without port security
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("Transit", {
 *   ipv4: { prefix: "10.0.9.0/24" },
 * });
 * yield* Stackit.IaaS.NetworkInterface("Router", {
 *   networkId: network.networkId,
 *   nicSecurity: false,
 *   allowedAddresses: ["0.0.0.0/0"],
 * });
 * ```
 *
 * ### Replacement
 * Changing `networkId`, `ipv4`, `ipv6`, `projectId` or `region` creates a
 * new interface and deletes the old one. A server attached to the old
 * interface loses it, and an associated public IP must be associated with
 * the new interface.
 *
 * @resource
 * @product STACKIT Network
 * @category IaaS
 */
export const NetworkInterface = Resource<NetworkInterface>("Stackit.IaaS.NetworkInterface");

const toAttrs = (
  nic: iaas.NIC,
  scope: ProjectScope,
  networkId: string,
): NetworkInterfaceAttributes => ({
  networkInterfaceId: nic.id ?? "",
  networkId: nic.networkId ?? networkId,
  ...scope,
  name: nic.name ?? "",
  description: nic.description,
  ipv4: nic.ipv4,
  ipv6: nic.ipv6,
  mac: nic.mac,
  device: nic.device,
  allowedAddresses: [...(nic.allowedAddresses ?? [])],
  nicSecurity: nic.nicSecurity ?? true,
  securityGroups: [...(nic.securityGroups ?? [])],
  status: nic.status,
  type: nic.type,
  labels: stripInternalLabels(nic.labels),
});

const getNic = (scope: ProjectScope, networkId: string, nicId: string) =>
  iaas
    .getNic({ ...scope, networkId, nicId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const observe = Effect.fn(function* (args: {
  id: string;
  name: string;
  scope: ProjectScope;
  networkId: string;
  nicId: string | undefined;
  ipv4: string | undefined;
  ipv6: string | undefined;
}) {
  if (args.nicId !== undefined) {
    const byId = yield* getNic(args.scope, args.networkId, args.nicId);
    if (byId !== undefined) return byId;
  }
  const { items } = yield* iaas
    .listNics({ ...args.scope, networkId: args.networkId })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed({ items: [] })));
  return yield* findOwnedByName(
    args.id,
    args.name,
    items,
    (nic) =>
      (args.ipv4 === undefined || nic.ipv4 === args.ipv4) &&
      (args.ipv6 === undefined || nic.ipv6 === args.ipv6),
  );
});

export const NetworkInterfaceProvider = () =>
  Provider.succeed(NetworkInterface, {
    stables: ["networkInterfaceId", "networkId", "projectId", "region", "mac"],
    nuke: { dependsOn: ["Stackit.IaaS.Network", "Stackit.IaaS.SecurityGroup"] },

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const { items } = yield* iaas.listProjectNICs(scope);
      return ownedOnly(items).map((nic) => toAttrs(nic, scope, nic.networkId ?? ""));
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      if (yield* projectScopeChanged(news, output)) return { action: "replace" } as const;
      if (output !== undefined && news.networkId !== output.networkId) {
        return { action: "replace" } as const;
      }
      if (olds !== undefined && (news.ipv4 !== olds.ipv4 || news.ipv6 !== olds.ipv6)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const networkId = output?.networkId ?? olds?.networkId;
      if (networkId === undefined) return undefined;
      const scope = yield* resolveProjectScope(olds, output);
      const name = output?.name ?? (yield* iaasName(id, olds?.name));
      const observed = yield* observe({
        id,
        name,
        scope,
        networkId,
        nicId: output?.networkInterfaceId,
        ipv4: olds?.ipv4,
        ipv6: olds?.ipv6,
      });
      if (observed === undefined) return undefined;
      const attrs = toAttrs(observed, scope, networkId);
      return (yield* hasAlchemyLabels(id, observed.labels)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const name = yield* iaasName(id, news.name);
      const labels = yield* desiredLabels(id, news.labels);
      const networkId = news.networkId;
      const nicSecurity = news.nicSecurity ?? true;

      let current = yield* observe({
        id,
        name,
        scope,
        networkId,
        nicId: output?.networkId === networkId ? output.networkInterfaceId : undefined,
        ipv4: news.ipv4,
        ipv6: news.ipv6,
      });
      if (current === undefined) {
        current = yield* iaas.createNic({
          ...scope,
          networkId,
          name,
          description: news.description,
          ipv4: news.ipv4,
          ipv6: news.ipv6,
          allowedAddresses: news.allowedAddresses,
          nicSecurity,
          securityGroups: news.securityGroups,
          labels,
        });
      }
      const nicId = current.id;
      if (nicId === undefined) {
        return yield* new NetworkInterfaceIdMissing({
          resourceName: name,
          message: `STACKIT returned network interface ${name} without an id`,
        });
      }

      const patch: Omit<iaas.UpdateNicRequest, "projectId" | "region" | "networkId" | "nicId"> = {};
      if (current.name !== name) patch.name = name;
      if (news.description !== undefined && current.description !== news.description) {
        patch.description = news.description;
      }
      if ((current.nicSecurity ?? true) !== nicSecurity) patch.nicSecurity = nicSecurity;
      if (
        news.allowedAddresses !== undefined &&
        !sameMembers(news.allowedAddresses, current.allowedAddresses)
      ) {
        patch.allowedAddresses = news.allowedAddresses;
      }
      if (
        news.securityGroups !== undefined &&
        !sameMembers(news.securityGroups, current.securityGroups)
      ) {
        patch.securityGroups = news.securityGroups;
      }
      const labelPatch = labelsPatch(current.labels, labels);
      if (labelPatch !== undefined) patch.labels = labelPatch;
      if (Object.keys(patch).length > 0) {
        // `Conflict` here is a typed validation conflict (e.g. security
        // groups with `nicSecurity: false`), not a transient state.
        current = yield* iaas.updateNic({ ...scope, networkId, nicId, ...patch });
      }
      return toAttrs({ ...current, id: nicId }, scope, networkId);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      yield* iaas
        .deleteNic({
          ...scope,
          networkId: output.networkId,
          nicId: output.networkInterfaceId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone({
        resource: `STACKIT network interface ${output.name}`,
        read: getNic(scope, output.networkId, output.networkInterfaceId),
        timeout: "1 minute",
      });
    }),
  });
