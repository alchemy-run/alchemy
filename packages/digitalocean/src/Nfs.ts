import * as DO from "@distilled.cloud/digitalocean";
import type { NfsResponse } from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { setEquals } from "./internal/equal.ts";
import { ignoreNotFound, noneIfNotFound } from "./internal/notFound.ts";
import { pollUntil, type PollBudget } from "./internal/poll.ts";
import type { Providers } from "./Providers.ts";
import type { RegionSlug } from "./Slugs.ts";

export type NfsProps = {
  /**
   * Share name. A change replaces the share and its data.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Region slug. A change replaces the share. */
  region: RegionSlug;
  /**
   * Size in GiB: at least 50 on the standard tier, 500 on the high tier.
   * Growing resizes in place; shrinking replaces the share.
   */
  sizeGib: number;
  /** VPCs whose droplets and clusters mount the share. Updates in place. */
  vpcIds: string[];
  /**
   * Performance tier.
   *
   * @default "standard"
   */
  performanceTier?: "standard" | "high";
};

export type Nfs = Resource<
  "DigitalOcean.Nfs",
  NfsProps,
  {
    /** Share id (UUID). */
    nfsId: string;
    /** Share name. */
    name: string;
    /** `ACTIVE` once mountable. */
    status: string;
    /** Region slug. */
    region: string;
    /** Size in GiB. */
    sizeGib: number;
    /** Host to mount from inside an attached VPC. */
    host: string | undefined;
    /** Export path to mount, `host:mountPath`. */
    mountPath: string | undefined;
  },
  never,
  Providers
>;

export type NfsAttributes = Nfs["Attributes"];

/**
 * A DigitalOcean managed NFS share: a network file system mounted by
 * droplets and Kubernetes pods in its VPCs. Growing `sizeGib` and changing
 * `vpcIds` update in place; `name`, `region` and shrinking replace the
 * share, which loses its data.
 *
 * ### Creating a Share
 * **Example:** Shared files for droplets in a VPC
 * ```typescript
 * const network = yield* DigitalOcean.Vpc("network", { region: "atl1" });
 * const share = yield* DigitalOcean.Nfs("files", {
 *   region: "atl1",
 *   sizeGib: 50,
 *   vpcIds: [network.vpcId],
 * });
 * // mount -t nfs ${share.host}:${share.mountPath} /mnt/files
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/NFS
 *
 * @resource
 * @product Network File Storage
 * @category Storage
 */
export const Nfs = Resource<Nfs>("DigitalOcean.Nfs");

export class NfsWaitTimedOut extends Data.TaggedError("DigitalOcean.NfsWaitTimedOut")<{
  readonly nfsId: string;
  readonly waitingFor: string;
  readonly lastStatus: string | undefined;
}> {
  override get message() {
    return `NFS share ${this.nfsId} timed out waiting for ${this.waitingFor} (last status: ${this.lastStatus ?? "missing"}).`;
  }
}

// A share provisions in a few minutes (≈ 10 min budget).
const NFS_POLL: PollBudget = { maxDelay: "10 seconds", times: 64 };

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const toAttrs = (share: NfsResponse): NfsAttributes => ({
  nfsId: share.id,
  name: share.name,
  status: share.status,
  region: share.region,
  sizeGib: share.size_gib,
  host: share.host,
  mountPath: share.mount_path,
});

const observeById = (nfsId: string, region: string) =>
  noneIfNotFound(DO.getNfs({ nfs_id: nfsId, region }).pipe(Effect.map((r) => r.share)));

const observeByName = (name: string, region: string) =>
  DO.listNfs({ region }).pipe(
    Effect.map((r) => Option.fromNullishOr((r.shares ?? []).find((share) => share.name === name))),
  );

const waitUntil = (
  nfsId: string,
  region: string,
  waitingFor: string,
  until: (share: NfsResponse) => boolean,
) =>
  pollUntil(observeById(nfsId, region), {
    ...NFS_POLL,
    until: (o): o is Option.Some<NfsResponse> => Option.isSome(o) && until(o.value),
    onTimeout: (last) =>
      new NfsWaitTimedOut({ nfsId, waitingFor, lastStatus: Option.getOrUndefined(last)?.status }),
  }).pipe(Effect.map((o) => o.value));

const action = (nfsId: string, region: string, body: DO.CreateNfsActionRequestBody) =>
  DO.createNfsAction({ nfs_id: nfsId, body: { ...body, region } as DO.CreateNfsActionRequestBody });

export const NfsProvider = () =>
  Provider.succeed(Nfs, {
    stables: ["nfsId", "name", "region"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ id, olds, output }) {
      if (output !== undefined) {
        const byId = yield* observeById(output.nfsId, output.region);
        if (Option.isSome(byId)) return toAttrs(byId.value);
      }
      if (olds.name !== undefined) return undefined;
      const generatedName = yield* physicalName(id);
      const named = yield* observeByName(generatedName, olds.region);
      return Option.getOrUndefined(Option.map(named, toAttrs));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (news.name !== olds.name || news.region !== olds.region || news.sizeGib < olds.sizeGib) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? output?.name ?? (yield* physicalName(id));
      const byId =
        output === undefined ? Option.none() : yield* observeById(output.nfsId, news.region);
      const observed = Option.isSome(byId) ? byId : yield* observeByName(name, news.region);
      const created = yield* Option.match(observed, {
        onNone: () =>
          DO.createNfs({
            name,
            region: news.region,
            size_gib: news.sizeGib,
            vpc_ids: news.vpcIds,
            performance_tier: news.performanceTier ?? "standard",
          }).pipe(Effect.map((r) => r.share)),
        onSome: Effect.succeed,
      });
      let share = yield* waitUntil(
        created.id,
        news.region,
        "the active state",
        (s) => s.status === "ACTIVE",
      );
      if (share.size_gib < news.sizeGib) {
        yield* action(share.id, news.region, {
          type: "resize",
          params: { size_gib: news.sizeGib },
        });
        share = yield* waitUntil(
          share.id,
          news.region,
          "the resize",
          (s) => s.size_gib >= news.sizeGib,
        );
      }
      const attached = share.vpc_ids ?? [];
      for (const vpcId of Arr.difference(news.vpcIds, attached)) {
        yield* action(share.id, news.region, { type: "attach", params: { vpc_id: vpcId } });
      }
      for (const vpcId of Arr.difference(attached, news.vpcIds)) {
        yield* action(share.id, news.region, { type: "detach", params: { vpc_id: vpcId } });
      }
      share = yield* waitUntil(
        share.id,
        news.region,
        "its VPCs",
        (s) => s.status === "ACTIVE" && setEquals(s.vpc_ids, news.vpcIds),
      );
      return toAttrs(share);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteNfs({ nfs_id: output.nfsId, region: output.region }));
      yield* pollUntil(observeById(output.nfsId, output.region), {
        ...NFS_POLL,
        until: (o) => Option.isNone(o) || o.value.status === "DELETED",
        onTimeout: () =>
          new NfsWaitTimedOut({
            nfsId: output.nfsId,
            waitingFor: "deletion",
            lastStatus: undefined,
          }),
      });
    }),
  });
