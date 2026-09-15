import * as iap from "@distilled.cloud/gcp/iap_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  desiredFqdns,
  destGroupNameOf,
  destGroupParent,
  getDestGroup,
  listOwnedDestGroups,
  normalizeLocation,
  ownedDestGroup,
  ownershipLabels,
  parseDestGroupName,
  replaceOnIdentity,
  sameStringList,
  toDestGroupId,
  uniqueStrings,
  updateMaskOf,
  userFqdns,
  waitUntilGone,
} from "./internal.ts";

export type IapDestGroupProps = {
  /**
   * Destination group id (the `{dest_group}` segment of
   * `projects/{project}/iap_tunnel/locations/{location}/destGroups/{dest_group}`).
   * If omitted, a unique name is generated. Must be 4-63 characters of
   * lowercase letters and dashes. Immutable — changing it replaces the
   * group.
   */
  destGroupId?: string;
  /**
   * Region of the destination group (`us-central1`, …). Immutable —
   * changing it replaces the group. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`.
   * @default "us-central1"
   */
  location?: string;
  /**
   * CIDR ranges this group matches (for example `10.1.0.0/16`).
   */
  cidrs?: string[];
  /**
   * Fully qualified domain names this group matches. TunnelDestGroups
   * have no labels field, so Alchemy stamps ownership into a reserved
   * `alc-{id}.alc.invalid` FQDN and strips it from attributes.
   */
  fqdns?: string[];
};

export type IapDestGroup = Resource<
  "GCP.Iap.IapDestGroup",
  IapDestGroupProps,
  {
    /** Full resource name `projects/{project}/iap_tunnel/locations/{location}/destGroups/{dest_group}`. */
    name: string;
    /** Destination group id (last path segment). */
    destGroupId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** CIDR ranges this group matches. */
    cidrs: string[];
    /** User FQDNs with the Alchemy ownership FQDN stripped. */
    fqdns: string[];
  },
  never,
  Providers
>;

/**
 * An Identity-Aware Proxy TCP-forwarding tunnel destination group.
 *
 * Destination groups have no labels field, so Alchemy stamps ownership
 * into a reserved FQDN for `list` / nuke. `destGroupId` and `location`
 * are identity — changing either replaces the group. CIDRs and FQDNs
 * update in place.
 *
 * ### Creating a Destination Group
 * **Example:** Generated name with CIDRs
 * ```typescript
 * const group = yield* GCP.Iap.IapDestGroup("SshHosts", {
 *   cidrs: ["10.1.0.0/16"],
 * });
 * ```
 *
 * **Example:** Named group with FQDNs
 * ```typescript
 * const group = yield* GCP.Iap.IapDestGroup("SshHosts", {
 *   destGroupId: "prod-ssh",
 *   location: "us-central1",
 *   fqdns: ["*.internal.example.com"],
 * });
 * ```
 *
 * ### Updating a Destination Group
 * **Example:** Add CIDRs and FQDNs
 * ```typescript
 * const group = yield* GCP.Iap.IapDestGroup("SshHosts", {
 *   destGroupId: existing.destGroupId,
 *   location: existing.location,
 *   cidrs: ["10.1.0.0/16", "192.168.2.0/24"],
 *   fqdns: ["db.internal.example.com"],
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Iap
 */
export const IapDestGroup = Resource<IapDestGroup>("GCP.Iap.IapDestGroup");

export class IapDestGroupNotResolved extends Data.TaggedError(
  "GCP.Iap.IapDestGroupNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (group: iap.TunnelDestGroup, project: string) => {
  const name = group.name ?? "";
  const parsed = parseDestGroupName(name, project);
  return {
    name,
    destGroupId: parsed.destGroupId,
    project,
    location: parsed.location,
    cidrs: uniqueStrings(group.cidrs),
    fqdns: userFqdns(group.fqdns),
  };
};

export const IapDestGroupProvider = () =>
  Provider.succeed(IapDestGroup, {
    stables: ["name", "destGroupId", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousId: olds?.destGroupId ?? output?.destGroupId,
        nextId: news.destGroupId,
        previousParent: normalizeLocation(
          olds?.location ?? output?.location ?? DEFAULT_LOCATION,
        ),
        nextParent:
          news.location !== undefined
            ? normalizeLocation(news.location)
            : undefined,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? DEFAULT_LOCATION,
      );
      const destGroupId = yield* toDestGroupId(
        id,
        olds?.destGroupId,
        output?.destGroupId,
      );
      const name =
        output?.name ?? destGroupNameOf(env.project, location, destGroupId);
      const existing = yield* getDestGroup(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedDestGroup(id, existing.fqdns))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const groups = yield* listOwnedDestGroups(env.project);
        return groups.map((group) => toAttrs(group, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? DEFAULT_LOCATION,
      );
      const destGroupId = yield* toDestGroupId(
        id,
        news.destGroupId,
        output?.destGroupId,
      );
      const name = destGroupNameOf(env.project, location, destGroupId);
      const parent = destGroupParent(env.project, location);
      const ownership = yield* ownershipLabels(id);
      const cidrs = uniqueStrings(news.cidrs);
      const fqdns = desiredFqdns(ownership, news.fqdns);

      let current = yield* getDestGroup(output?.name ?? name);

      if (current === undefined) {
        const created = yield* iap
          .createProjectsIap_tunnelLocationsDestGroups({
            parent,
            tunnelDestGroupId: destGroupId,
            body: { name, cidrs, fqdns },
          })
          .pipe(Effect.catchTag("Conflict", () => getDestGroup(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new IapDestGroupNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const cidrsChanged = !sameStringList(current.cidrs, cidrs);
      const fqdnsChanged = !sameStringList(current.fqdns, fqdns);
      if (cidrsChanged || fqdnsChanged) {
        current = yield* iap.patchProjectsIap_tunnelLocationsDestGroups({
          name: currentName,
          updateMask: updateMaskOf(
            cidrsChanged ? "cidrs" : undefined,
            fqdnsChanged ? "fqdns" : undefined,
          ),
          body: { name: currentName, cidrs, fqdns },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* iap
        .deleteProjectsIap_tunnelLocationsDestGroups({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getDestGroup(output.name));
    }),
  });
