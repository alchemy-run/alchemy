import * as DO from "@distilled.cloud/digitalocean";
import type { Snapshots } from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { waitForAction } from "./Droplet.ts";
import { ignoreNotFound, noneIfNotFound } from "./internal/notFound.ts";
import type { PollBudget } from "./internal/poll.ts";
import type { Providers } from "./Providers.ts";

export type DropletSnapshotProps = {
  /** The Droplet to snapshot. A change takes a new snapshot. */
  dropletId: number;
  /**
   * Snapshot name. A change takes a new snapshot.
   *
   * @default a generated physical name
   */
  name?: string;
};

export type DropletSnapshot = Resource<
  "DigitalOcean.DropletSnapshot",
  DropletSnapshotProps,
  {
    /** Snapshot id; pass it as a Droplet's `image` to boot from it. */
    snapshotId: string;
    /** Snapshot name. */
    name: string;
    /** Regions the snapshot is available in. */
    regions: string[];
    /** Smallest disk, in GiB, a Droplet booted from it needs. */
    minDiskSize: number;
    /** Size of the snapshot, in GiB. */
    sizeGigabytes: number;
  },
  never,
  Providers
>;

export type DropletSnapshotAttributes = DropletSnapshot["Attributes"];

/**
 * A snapshot of a Droplet's disk, taken once when the resource is created.
 * Boot new Droplets from it by passing `snapshotId` as their `image`. The
 * Droplet keeps running while the snapshot is taken.
 *
 * ### Taking a Snapshot
 * **Example:** Snapshot a configured host
 * ```typescript
 * const snap = yield* DigitalOcean.DropletSnapshot("golden", {
 *   dropletId: host.dropletId,
 * });
 * yield* DigitalOcean.Droplet("clone", {
 *   region: "nyc3",
 *   size: "s-1vcpu-1gb",
 *   image: snap.snapshotId,
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/products/snapshots/
 *
 * @resource
 * @product Droplets
 * @category Compute
 */
export const DropletSnapshot = Resource<DropletSnapshot>("DigitalOcean.DropletSnapshot");

// A snapshot of a small Droplet takes one to five minutes (≈ 10 min budget).
const SNAPSHOT_POLL: PollBudget = { maxDelay: "10 seconds", times: 60 };

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const toAttrs = (snapshot: Snapshots): DropletSnapshotAttributes => ({
  snapshotId: String(snapshot.id),
  name: snapshot.name,
  regions: [...snapshot.regions],
  minDiskSize: snapshot.min_disk_size,
  sizeGigabytes: snapshot.size_gigabytes,
});

const observeById = (snapshotId: string) =>
  noneIfNotFound(DO.getSnapshot({ snapshot_id: snapshotId }).pipe(Effect.map((r) => r.snapshot)));

const observeByName = (dropletId: number, name: string) =>
  DO.listDropletSnapshots.items({ droplet_id: dropletId, per_page: 200 }).pipe(
    Stream.filter((snapshot) => snapshot.name === name),
    Stream.runHead,
    Effect.catchTag("NotFound", () => Effect.succeedNone),
    Effect.flatMap((found) =>
      Option.isSome(found) ? observeById(String(found.value.id)) : Effect.succeedNone,
    ),
  );

export const DropletSnapshotProvider = () =>
  Provider.succeed(DropletSnapshot, {
    stables: ["snapshotId", "regions", "minDiskSize", "sizeGigabytes"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ id, olds, output }) {
      if (output !== undefined) {
        const byId = yield* observeById(output.snapshotId);
        if (Option.isSome(byId)) return toAttrs(byId.value);
      }
      const name = olds.name ?? (yield* physicalName(id));
      const named = yield* observeByName(olds.dropletId, name);
      return Option.getOrUndefined(Option.map(named, toAttrs));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (news.dropletId !== olds.dropletId || news.name !== olds.name) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? output?.name ?? (yield* physicalName(id));
      const byId = output === undefined ? Option.none() : yield* observeById(output.snapshotId);
      const existing = Option.isSome(byId) ? byId : yield* observeByName(news.dropletId, name);
      if (Option.isSome(existing)) return toAttrs(existing.value);
      const posted = yield* DO.postDropletAction({
        droplet_id: news.dropletId,
        body: { type: "snapshot", name },
      });
      yield* waitForAction(news.dropletId, posted.action.id, SNAPSHOT_POLL);
      const taken = yield* observeByName(news.dropletId, name);
      return yield* Option.match(taken, {
        onSome: (snapshot) => Effect.succeed(toAttrs(snapshot)),
        onNone: () =>
          observeByName(news.dropletId, name).pipe(
            Effect.flatMap(Effect.fromOption),
            Effect.map(toAttrs),
            Effect.retry({ times: 6 }),
          ),
      });
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteSnapshot({ snapshot_id: output.snapshotId }));
    }),
  });
