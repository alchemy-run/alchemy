/**
 * A volume's heads from a Worker or Durable Object, over the R2 binding
 * `Cloudflare.R2.Volume` binds: the same objects blockd reads and writes
 * through R2's S3 API. `<prefix>/heads/<name>` holds the head's record: its
 * snapshot, the epoch of its lease and its journal position (JSON; a bare
 * snapshot id from before leases also reads). `<prefix>/manifests/<id>`
 * names its parent. Provided to every Worker and Durable Object as the
 * `Sandbox.VolumeRuntime`.
 *
 * NOT exported from `index.ts`.
 */
import {
  VolumeConflict,
  VolumeError,
  VolumeRuntime,
  type Snapshot,
  type VolumeHeads,
  type VolumeHostDescriptor,
} from "@alchemy.run/sandbox/Volume";
import { sanitizeKey } from "alchemy/RuntimeContext";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { WorkerEnvironment } from "./WorkerRuntime.ts";

/** The `Sandbox.VolumeHostDescriptor.host` of an R2-hosted volume. */
export const R2_VOLUME_HOST = "Cloudflare.R2.Volume";

/** The R2 binding a volume's host binds into the Worker. */
export const volumeBucketBinding = (id: string) => sanitizeKey(`ALCHEMY_VOLUME_${id}_BUCKET`);

const HEAD = /^[A-Za-z0-9._-]{1,200}$/;

/** A head's record, as `volume::store::Head` writes it. */
interface HeadRecord {
  readonly snapshot: Snapshot;
  readonly epoch?: number;
  readonly seq?: number;
  readonly pending?: { readonly epoch: number; readonly seq: number } | null;
  /** A deleted head: kept so a head of the same name never reuses an epoch. */
  readonly deleted?: boolean;
}

const decodeHead = (text: string): HeadRecord | undefined => {
  const trimmed = text.trim();
  if (/^[0-9a-f]{64}$/.test(trimmed)) return { snapshot: trimmed as Snapshot };
  try {
    const record = JSON.parse(trimmed) as HeadRecord;
    return typeof record.snapshot === "string" ? record : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A new record on `snapshot`. Its epoch is past `previous`'s, which fences
 * whoever held the head's lease and drops the journal it hadn't folded.
 */
const nextHead = (snapshot: Snapshot, previous: HeadRecord | undefined, deleted = false) =>
  JSON.stringify({
    snapshot,
    epoch: previous ? (previous.epoch ?? 0) + 1 : 0,
    seq: 0,
    pending: null,
    ...(deleted ? { deleted: true } : {}),
  });

interface R2Object {
  readonly etag: string;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}
interface R2Bucket {
  get(key: string): Promise<R2Object | null>;
  head(key: string): Promise<{ readonly etag: string } | null>;
  put(
    key: string,
    value: string,
    options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } },
  ): Promise<unknown | null>;
}

const makeHeads = (
  id: string,
  descriptor: VolumeHostDescriptor,
  env: Record<string, unknown>,
): VolumeHeads => {
  const prefix = descriptor.store.replace(/^s3:\/\/[^/]+\//, "");
  const bucket = () => env[volumeBucketBinding(id)] as R2Bucket | undefined;
  const call = <A>(what: string, run: (bucket: R2Bucket) => Promise<A>) =>
    Effect.tryPromise({
      try: () => {
        const found = bucket();
        if (!found) throw new Error(`volume ${id}'s bucket isn't bound to this Worker`);
        return run(found);
      },
      catch: (cause) => new VolumeError({ message: `${what}: ${String(cause)}`, cause }),
    });
  const check = (head: string) =>
    HEAD.test(head)
      ? Effect.void
      : Effect.fail(new VolumeError({ message: `invalid head name ${JSON.stringify(head)}` }));
  /** The head's object, tombstones included. */
  const readObject = Effect.fn(function* (head: string) {
    yield* check(head);
    const object = yield* call("reading a head", (b) => b.get(`${prefix}/heads/${head}`));
    if (!object) return undefined;
    const text = yield* call("reading a head", () => object.text());
    const record = decodeHead(text);
    if (!record) return yield* new VolumeError({ message: `head ${head} is corrupt` });
    return { record, etag: object.etag };
  });
  const read = Effect.fn(function* (head: string) {
    const found = yield* readObject(head);
    return found && !found.record.deleted ? found : undefined;
  });
  /** Writes the head if its object still has `etag` (or doesn't exist, for `undefined`). */
  const replace = (head: string, value: string, etag: string | undefined) =>
    call("writing a head", (b) =>
      b.put(`${prefix}/heads/${head}`, value, {
        onlyIf: etag === undefined ? { etagDoesNotMatch: "*" } : { etagMatches: etag },
      }),
    );
  return {
    head: (name) => Effect.map(read(name), (found) => found?.record.snapshot),
    fork: Effect.fn(function* (to, options = {}) {
      const from = options.from ?? descriptor.base;
      const source = yield* read(from);
      if (!source) return yield* new VolumeError({ message: `head ${from} does not exist` });
      const existing = yield* readObject(to);
      if (existing && !existing.record.deleted)
        return yield* new VolumeConflict({ message: `head ${to} already exists`, head: to });
      const created = yield* replace(
        to,
        nextHead(source.record.snapshot, existing?.record),
        existing?.etag,
      );
      if (created === null)
        return yield* new VolumeConflict({ message: `head ${to} already exists`, head: to });
      return source.record.snapshot;
    }),
    reset: Effect.fn(function* (head, snapshot) {
      const current = yield* read(head);
      if (!current) return yield* new VolumeError({ message: `head ${head} does not exist` });
      const exists = yield* call("reading a snapshot", (b) =>
        b.head(`${prefix}/manifests/${snapshot}`),
      );
      if (!exists)
        return yield* new VolumeError({ message: `snapshot ${snapshot} does not exist` });
      const moved = yield* replace(head, nextHead(snapshot, current.record), current.etag);
      if (moved === null) return yield* new VolumeConflict({ message: `head ${head} moved`, head });
    }),
    drop: Effect.fn(function* (head) {
      const current = yield* read(head);
      if (!current) return;
      const dropped = yield* replace(
        head,
        nextHead(current.record.snapshot, current.record, true),
        current.etag,
      );
      if (dropped === null)
        return yield* new VolumeConflict({ message: `head ${head} moved`, head });
    }),
    history: Effect.fn(function* (head, options = {}) {
      const limit = options.limit ?? 20;
      const start = yield* read(head);
      const out: Array<Snapshot> = [];
      let next: Snapshot | undefined = start?.record.snapshot;
      while (next && out.length < limit) {
        const manifest = yield* call("reading a snapshot", (b) =>
          b.get(`${prefix}/manifests/${next}`),
        );
        if (!manifest) break; // history garbage collected
        out.push(next);
        next = parentOf(
          new Uint8Array(yield* call("reading a snapshot", () => manifest.arrayBuffer())),
        );
      }
      return out;
    }),
  };
};

/** `"AVMF" | version | size: u64 | extent: u32 | parent: flag + [u8; 32]` */
const parentOf = (manifest: Uint8Array): Snapshot | undefined => {
  const flag = manifest[17];
  if (flag !== 1) return undefined;
  return Array.from(manifest.subarray(18, 50), (b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * Provide `Sandbox.VolumeRuntime` to a Worker's or Durable Object's constructor,
 * reading the Worker's environment where the constructor runs.
 */
export const provideVolumeRuntime = <A, E, R>(
  constructor: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, VolumeRuntime>> =>
  Effect.flatMap(Effect.context<never>(), (services) =>
    Effect.provideService(constructor, VolumeRuntime, {
      connect: (id, descriptor) =>
        Effect.map(
          Effect.serviceOption(WorkerEnvironment).pipe(
            Effect.provide(services as Context.Context<WorkerEnvironment>),
          ),
          (env) =>
            makeHeads(
              id,
              descriptor,
              env._tag === "Some" ? (env.value as Record<string, unknown>) : {},
            ),
        ),
    }),
  );
