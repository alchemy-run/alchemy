import * as DO from "@distilled.cloud/digitalocean";
import type { Vpc as ApiVpc } from "@distilled.cloud/digitalocean";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { ignoreNotFound, noneIfNotFound } from "./internal/notFound.ts";
import { pollUntil, type PollBudget } from "./internal/poll.ts";
import type { Providers } from "./Providers.ts";
import type { RegionSlug } from "./Slugs.ts";

export type VpcProps = {
  /**
   * VPC name, unique within the team. Letters, digits, `-` and `.`. A
   * change renames the VPC in place.
   *
   * @default a generated physical name
   */
  name?: string;

  /**
   * Region slug. A change replaces the VPC. With a chosen `name`, the old
   * VPC is deleted before the new one is created, because names are unique.
   */
  region: RegionSlug;

  /**
   * Private IPv4 range in CIDR notation, for example `"10.10.10.0/24"`. It
   * must not overlap another VPC on the team. A change replaces the VPC.
   *
   * @default a range DigitalOcean picks
   */
  ipRange?: string;

  /** Free-form description, at most 255 characters. A change updates the VPC in place. */
  description?: string;
};

export type Vpc = Resource<
  "DigitalOcean.Vpc",
  VpcProps,
  {
    /** VPC id (UUID). */
    vpcId: string;
    /** Uniform resource name, `do:vpc:<id>`. */
    urn: string;
    /** VPC name. */
    name: string;
    /** Region slug. */
    region: string;
    /** Private IPv4 range in CIDR notation. */
    ipRange: string;
    /** Description, when one is set. */
    description: string | undefined;
    /** Whether this is the region's default VPC. */
    isDefault: boolean;
    /** ISO 8601 creation time. */
    createdAt: string;
  },
  never,
  Providers
>;

export type VpcAttributes = Vpc["Attributes"];

/**
 * A DigitalOcean VPC: a private network for droplets, Kubernetes clusters,
 * load balancers and databases in one region. Resources in the same VPC
 * reach each other on private addresses. `name` and `description` update
 * in place; `region` and `ipRange` replace the VPC.
 *
 * A VPC has no tags. Alchemy owns a VPC whose name it generated, or whose
 * id it recorded. A VPC that already has the chosen name is `Unowned` and
 * needs `--adopt`. Alchemy never makes a VPC the region's default, and a
 * default VPC cannot be deleted.
 *
 * ### Creating a VPC
 * **Example:** A VPC with a chosen range
 * ```typescript
 * const network = yield* DigitalOcean.Vpc("network", {
 *   region: "sfo3",
 *   ipRange: "10.20.0.0/20",
 *   description: "app network",
 * });
 * ```
 *
 * ### Placing Droplets in a VPC
 * **Example:** A droplet on the private network
 * ```typescript
 * const network = yield* DigitalOcean.Vpc("network", { region: "sfo3" });
 * const host = yield* DigitalOcean.Droplet("app", {
 *   region: "sfo3",
 *   size: "s-1vcpu-1gb",
 *   image: "ubuntu-24-04-x64",
 *   vpcUuid: network.vpcId,
 * });
 * // host.privateIpv4 is an address in network.ipRange.
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/VPCs
 *
 * @resource
 * @product VPC
 * @category Networking
 */
export const Vpc = Resource<Vpc>("DigitalOcean.Vpc");

export class VpcWaitTimedOut extends Data.TaggedError("DigitalOcean.VpcWaitTimedOut")<{
  readonly vpcId: string;
  readonly waitingFor: string;
}> {
  override get message() {
    return `VPC ${this.vpcId} timed out waiting for ${this.waitingFor}.`;
  }
}

const NAME_MAX_LENGTH = 255;

const PAGE_SIZE = 200;

// GET lags a change by a few seconds.
const VPC_POLL: PollBudget = { maxDelay: "3 seconds", times: 20 };

const toAttrs = (vpc: ApiVpc): VpcAttributes => ({
  vpcId: vpc.id,
  urn: vpc.urn,
  name: vpc.name,
  region: vpc.region,
  ipRange: vpc.ip_range,
  description: vpc.description || undefined,
  isDefault: vpc.default,
  createdAt: vpc.created_at,
});

const physicalName = (id: string) => createPhysicalName({ id, maxLength: NAME_MAX_LENGTH });

const observeById = (vpcId: string) =>
  noneIfNotFound(DO.getVpc({ vpc_id: vpcId }).pipe(Effect.map((response) => response.vpc)));

const observeByName = (name: string) =>
  DO.listVpcs.items({ per_page: PAGE_SIZE }).pipe(
    Stream.filter((vpc) => vpc.name === name),
    Stream.runHead,
  );

// The stored id is a cache; a generated name finds the VPC without it. A
// chosen name proves nothing, because someone else may hold it.
const observeOwned = Effect.fn(function* (
  vpcId: string | undefined,
  generatedName: string | undefined,
) {
  if (vpcId !== undefined) {
    const byId = yield* observeById(vpcId);
    if (Option.isSome(byId)) return byId;
  }
  if (generatedName === undefined) return Option.none<ApiVpc>();
  return yield* observeByName(generatedName);
});

const waitUntilGone = (vpcId: string) =>
  pollUntil(observeById(vpcId), {
    ...VPC_POLL,
    until: Option.isNone,
    onTimeout: () => new VpcWaitTimedOut({ vpcId, waitingFor: "deletion" }),
  });

const syncSettings = Effect.fn(function* (vpc: ApiVpc, name: string, news: VpcProps) {
  const description = news.description ?? "";
  if (vpc.name === name && (vpc.description ?? "") === description) return vpc;
  const patched = yield* DO.patchVpc({ vpc_id: vpc.id, name, description });
  return patched.vpc;
});

export const VpcProvider = () =>
  Provider.succeed(Vpc, {
    stables: ["vpcId", "urn", "region", "ipRange", "createdAt"],
    // A VPC carries no ownership marker, so a list cannot tell the VPCs
    // Alchemy created from the rest of the team's.
    nuke: { skip: true },
    list: Effect.fn(function* () {
      const vpcs = yield* DO.listVpcs.items({ per_page: PAGE_SIZE }).pipe(Stream.runCollect);
      return vpcs.filter((vpc) => !vpc.default).map(toAttrs);
    }),
    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const generatedName = olds.name === undefined ? yield* physicalName(id) : undefined;
      const owned = yield* observeOwned(output?.vpcId, generatedName);
      if (Option.isSome(owned)) return toAttrs(owned.value);
      if (olds.name === undefined) return undefined;
      const named = yield* observeByName(olds.name);
      // A replacement under a chosen name finds the generation it replaces.
      const previousVpcId = previous?.vpcId;
      return named.pipe(
        Option.map((vpc) => (vpc.id === previousVpcId ? toAttrs(vpc) : Unowned(toAttrs(vpc)))),
        Option.getOrUndefined,
      );
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (news.region !== olds.region || news.ipRange !== olds.ipRange) {
        // Names are unique, so a chosen name frees up before the new VPC takes it.
        return { action: "replace", deleteFirst: news.name !== undefined } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? (yield* physicalName(id));
      const generatedName = news.name === undefined ? name : undefined;

      const observed = yield* observeOwned(output?.vpcId, generatedName);
      const vpc = yield* Option.match(observed, {
        onNone: () =>
          DO.createVpc({
            name,
            region: news.region,
            ip_range: news.ipRange,
            description: news.description,
          }).pipe(Effect.map((response) => response.vpc)),
        onSome: Effect.succeed,
      });
      return toAttrs(yield* syncSettings(vpc, name, news));
    }),
    delete: Effect.fn(function* ({ output }) {
      // A destroyed member keeps the VPC busy for up to a minute or two.
      yield* ignoreNotFound(DO.deleteVpc({ vpc_id: output.vpcId })).pipe(
        Effect.retry({
          while: (error) => error._tag === "VpcHasMembers",
          schedule: Schedule.spaced("5 seconds"),
          times: 30,
        }),
      );
      yield* waitUntilGone(output.vpcId);
    }),
  });
