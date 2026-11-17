import * as DO from "@distilled.cloud/digitalocean";
import type { VpcPeering as ApiVpcPeering, VpcPeeringStatus } from "@distilled.cloud/digitalocean";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { setEquals } from "./internal/equal.ts";
import { ignoreNotFound, noneIfNotFound } from "./internal/notFound.ts";
import { pollUntil, type PollBudget } from "./internal/poll.ts";
import type { Providers } from "./Providers.ts";

export type VpcPeeringProps = {
  /**
   * Peering name, unique within the team. A change renames it in place.
   *
   * @default a generated physical name
   */
  name?: string;
  /** The two VPCs to connect, in any regions. A change replaces the peering. */
  vpcIds: [string, string];
};

export type VpcPeering = Resource<
  "DigitalOcean.VpcPeering",
  VpcPeeringProps,
  {
    /** Peering id (UUID). */
    vpcPeeringId: string;
    /** Peering name. */
    name: string;
    /** The two peered VPCs. */
    vpcIds: string[];
    /** `ACTIVE` once traffic flows. */
    status: VpcPeeringStatus;
    /** ISO 8601 creation time. */
    createdAt: string;
  },
  never,
  Providers
>;

export type VpcPeeringAttributes = VpcPeering["Attributes"];

/**
 * A DigitalOcean VPC peering: routes private traffic between two VPCs,
 * also across regions. Their IP ranges must not overlap. A new `vpcIds`
 * pair replaces the peering; `name` updates in place.
 *
 * ### Peering Two VPCs
 * **Example:** Connect a VPC in New York to one in Amsterdam
 * ```typescript
 * const nyc = yield* DigitalOcean.Vpc("nyc", { region: "nyc3", ipRange: "10.10.0.0/20" });
 * const ams = yield* DigitalOcean.Vpc("ams", { region: "ams3", ipRange: "10.20.0.0/20" });
 * yield* DigitalOcean.VpcPeering("nyc-ams", { vpcIds: [nyc.vpcId, ams.vpcId] });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/VPC-Peerings
 *
 * @resource
 * @product VPC
 * @category Networking
 */
export const VpcPeering = Resource<VpcPeering>("DigitalOcean.VpcPeering");

export class VpcPeeringWaitTimedOut extends Data.TaggedError(
  "DigitalOcean.VpcPeeringWaitTimedOut",
)<{
  readonly vpcPeeringId: string;
  readonly waitingFor: string;
}> {
  override get message() {
    return `VPC peering ${this.vpcPeeringId} timed out waiting for ${this.waitingFor}.`;
  }
}

// A peering becomes active within a minute or two (≈ 4 min budget).
const PEERING_POLL: PollBudget = { maxDelay: "10 seconds", times: 30 };

const NAME_MAX_LENGTH = 255;

const physicalName = (id: string) =>
  createPhysicalName({ id, lowercase: true, maxLength: NAME_MAX_LENGTH });

const toAttrs = (peering: ApiVpcPeering): VpcPeeringAttributes => ({
  vpcPeeringId: peering.id,
  name: peering.name,
  vpcIds: [...peering.vpc_ids],
  status: peering.status,
  createdAt: peering.created_at,
});

const observeById = (vpcPeeringId: string) =>
  noneIfNotFound(
    DO.getVpcPeering({ vpc_peering_id: vpcPeeringId }).pipe(Effect.map((r) => r.vpc_peering)),
  );

const observeByName = (name: string) =>
  DO.listVpcPeerings2.items({ per_page: 200 }).pipe(
    Stream.filter((peering) => peering.name === name),
    Stream.runHead,
  );

const observeOwned = Effect.fn(function* (
  vpcPeeringId: string | undefined,
  generatedName: string | undefined,
) {
  if (vpcPeeringId !== undefined) {
    const byId = yield* observeById(vpcPeeringId);
    if (Option.isSome(byId)) return byId;
  }
  if (generatedName === undefined) return Option.none<ApiVpcPeering>();
  return yield* observeByName(generatedName);
});

const waitUntilGone = (vpcPeeringId: string) =>
  pollUntil(observeById(vpcPeeringId), {
    ...PEERING_POLL,
    until: Option.isNone,
    onTimeout: () => new VpcPeeringWaitTimedOut({ vpcPeeringId, waitingFor: "deletion" }),
  });

export const VpcPeeringProvider = () =>
  Provider.succeed(VpcPeering, {
    stables: ["vpcPeeringId", "vpcIds", "createdAt"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const generatedName = olds.name === undefined ? yield* physicalName(id) : undefined;
      const owned = yield* observeOwned(output?.vpcPeeringId, generatedName);
      if (Option.isSome(owned)) return toAttrs(owned.value);
      if (olds.name === undefined) return undefined;
      const named = yield* observeByName(olds.name);
      return named.pipe(
        Option.map((p) => (p.id === previous?.vpcPeeringId ? toAttrs(p) : Unowned(toAttrs(p)))),
        Option.getOrUndefined,
      );
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (!setEquals(news.vpcIds, olds.vpcIds)) {
        // Two VPCs peer once, so the old peering goes first.
        return { action: "replace", deleteFirst: true } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? (yield* physicalName(id));
      const generatedName = news.name === undefined ? name : undefined;
      const observed = yield* observeOwned(output?.vpcPeeringId, generatedName);
      const peering = yield* Option.match(observed, {
        onNone: () =>
          DO.createVpcPeering({ name, vpc_ids: [...news.vpcIds] }).pipe(
            Effect.map((r) => r.vpc_peering),
          ),
        onSome: Effect.succeed,
      });
      if (peering.name !== name) {
        yield* DO.patchVpcPeering({ vpc_peering_id: peering.id, name });
      }
      const active = yield* pollUntil(observeById(peering.id), {
        ...PEERING_POLL,
        until: (o): o is Option.Some<ApiVpcPeering> =>
          Option.isSome(o) && o.value.status === "ACTIVE" && o.value.name === name,
        onTimeout: () =>
          new VpcPeeringWaitTimedOut({ vpcPeeringId: peering.id, waitingFor: "the active state" }),
      });
      return toAttrs(active.value);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteVpcPeering({ vpc_peering_id: output.vpcPeeringId }));
      yield* waitUntilGone(output.vpcPeeringId);
    }),
  });
