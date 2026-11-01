import * as iaas from "@distilled.cloud/stackit/iaas";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger } from "../internal/diff.ts";
import { waitUntilGone } from "../internal/wait.ts";
import { desiredLabels, hasAlchemyLabels, stripInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  labelsPatch,
  ownedOnly,
  projectScopeChanged,
  resolveProjectScope,
  type ProjectScope,
} from "./internal.ts";

/** The create response of a public IP carried no id. */
export class PublicIpIdMissing extends Data.TaggedError("Stackit.IaaS.PublicIpIdMissing")<{
  readonly message: string;
}> {}

export interface PublicIpProps {
  /**
   * Project to allocate the public IP in. Defaults to the profile's
   * project. Changing it replaces the public IP (and its address).
   */
  projectId?: string;
  /**
   * Region of the public IP. Defaults to the profile's region. Changing it
   * replaces the public IP (and its address).
   */
  region?: string;
  /**
   * Network interface to associate the public IP with. `null` dissociates
   * it; when omitted, the association is not managed (so a server
   * attachment made elsewhere is kept). Updated in place.
   */
  networkInterfaceId?: string | null;
  /**
   * User labels. Alchemy's ownership labels (`alchemy.stack`,
   * `alchemy.stage`, `alchemy.id`) are added automatically.
   */
  labels?: Record<string, string>;
}

export interface PublicIpAttributes {
  /** Public IP id (UUID). */
  publicIpId: string;
  /** The allocated IPv4 address. */
  ip: string;
  /** Project the public IP belongs to. */
  projectId: string;
  /** Region of the public IP. */
  region: string;
  /** Network interface the IP is associated with, if any. */
  networkInterfaceId: string | undefined;
  /** User labels (Alchemy's ownership labels stripped). */
  labels: Record<string, string>;
}

export type PublicIp = Resource<
  "Stackit.IaaS.PublicIp",
  PublicIpProps,
  PublicIpAttributes,
  never,
  Providers
>;

/**
 * A STACKIT public IPv4 address, allocated to a project and optionally
 * associated with a network interface (NAT to the interface's private
 * address).
 *
 * The association and labels are updated in place; the address itself
 * never changes, so only a project or region change allocates a new one.
 * Public IPs are billed per hour while allocated.
 *
 * ### Allocating an address
 * **Example:** A reserved public IP
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const ip = yield* Stackit.IaaS.PublicIp("Ingress", {
 *   labels: { purpose: "ingress" },
 * });
 * ```
 *
 * ### Associating with a network interface
 * **Example:** Public IP for a network interface
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const nic = yield* Stackit.IaaS.NetworkInterface("Web", {
 *   networkId: network.networkId,
 * });
 * const ip = yield* Stackit.IaaS.PublicIp("Web", {
 *   networkInterfaceId: nic.networkInterfaceId,
 * });
 * ```
 *
 * ### Replacement
 * Changing `projectId` or `region` allocates a new address and releases
 * the old one. Every other change keeps the address.
 *
 * @resource
 * @product STACKIT Public IP
 * @category IaaS
 */
export const PublicIp = Resource<PublicIp>("Stackit.IaaS.PublicIp");

const toAttrs = (ip: iaas.PublicIp, scope: ProjectScope): PublicIpAttributes => ({
  publicIpId: ip.id ?? "",
  ip: ip.ip ?? "",
  ...scope,
  networkInterfaceId: ip.networkInterface ?? undefined,
  labels: stripInternalLabels(ip.labels),
});

const getIp = (scope: ProjectScope, publicIpId: string) =>
  iaas
    .getPublicIP({ ...scope, publicIpId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const observe = Effect.fn(function* (
  id: string,
  scope: ProjectScope,
  publicIpId: string | undefined,
) {
  if (publicIpId !== undefined) {
    const byId = yield* getIp(scope, publicIpId);
    if (byId !== undefined) return byId;
  }
  // Public IPs have no name: recover by ownership labels alone.
  const { items } = yield* iaas.listPublicIPs(scope);
  for (const item of items) {
    if (yield* hasAlchemyLabels(id, item.labels)) return item;
  }
  return undefined;
});

export const PublicIpProvider = () =>
  Provider.succeed(PublicIp, {
    stables: ["publicIpId", "ip", "projectId", "region"],

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const { items } = yield* iaas.listPublicIPs(scope);
      return ownedOnly(items).map((ip) => toAttrs(ip, scope));
    }),

    diff: Effect.fn(function* ({ news, output }) {
      // Delete-first: a public IP has no name, so recovery matches on labels
      // alone, and an unresolved scope can resolve to the current one.
      if (
        output !== undefined &&
        hasUnresolvedTrigger<PublicIpProps>(news, ["projectId", "region"])
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      if (!isResolved(news)) return undefined;
      if (yield* projectScopeChanged(news, output)) return { action: "replace" } as const;
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const scope = yield* resolveProjectScope(olds, output);
      const observed = yield* observe(id, scope, output?.publicIpId);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(observed, scope);
      return (yield* hasAlchemyLabels(id, observed.labels)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const labels = yield* desiredLabels(id, news.labels);

      let current = yield* observe(id, scope, output?.publicIpId);
      if (current === undefined) {
        current = yield* iaas.createPublicIP({
          ...scope,
          labels,
          networkInterface: news.networkInterfaceId,
        });
      }
      const publicIpId = current.id;
      if (publicIpId === undefined) {
        return yield* new PublicIpIdMissing({
          message: "STACKIT returned a public IP without an id",
        });
      }

      const labelPatch = labelsPatch(current.labels, labels);
      const associate =
        news.networkInterfaceId !== undefined &&
        (current.networkInterface ?? null) !== news.networkInterfaceId;
      if (labelPatch !== undefined || associate) {
        current = yield* iaas.updatePublicIP({
          ...scope,
          publicIpId,
          labels: labelPatch,
          networkInterface: associate ? news.networkInterfaceId : undefined,
        });
      }
      return toAttrs({ ...current, id: publicIpId }, scope);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      yield* iaas
        .deletePublicIP({ ...scope, publicIpId: output.publicIpId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone({
        resource: `STACKIT public IP ${output.ip}`,
        read: getIp(scope, output.publicIpId),
        timeout: "1 minute",
      });
    }),
  });
