import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Paths from "../internal/Paths.ts";
import * as System from "../internal/System.ts";
import { SystemError } from "../RuntimeError.shared.ts";
import {
  resolvedTargetKey,
  type RegistryEntry,
  type ResolvedTargetMap,
  type Subscriber,
} from "./RegistryTypes.shared.ts";

export class Registry extends Context.Service<
  Registry,
  {
    /**
     * Reads the registry and returns the resolved targets for the given subscribers.
     */
    readonly read: (
      subscribers: ReadonlyArray<Subscriber>,
    ) => Effect.Effect<ResolvedTargetMap>;
    /**
     * Subscribes to changes in the registry for the given subscribers.
     * Returns a stream containing an updated `ResolvedTargetMap` whenever the registry changes.
     */
    readonly subscribe: (
      subscribers: ReadonlyArray<Subscriber>,
    ) => Stream.Stream<ResolvedTargetMap>;
    /**
     * Writes an entry to the registry.
     * The entry is removed when the scope closes.
     */
    readonly write: (
      entry: RegistryEntry,
    ) => Effect.Effect<void, SystemError, Scope.Scope>;
  }
>()("cloudflare-runtime/registry/Registry") {}

const STALE_AFTER_MS = 300_000;

/**
 * Persist freshness in the file body. Effect's Node `FileSystem.stat` fails
 * with `BadArgument` when NTFS inodes exceed `Number.MAX_SAFE_INTEGER`, so
 * `mtime` is not a reliable staleness signal on Windows.
 */
const parseStored = (
  content: string,
):
  | { entry: RegistryEntry; writeId?: string; updatedAt?: number }
  | undefined => {
  try {
    const stored = JSON.parse(content) as RegistryEntry & {
      writeId?: unknown;
      updatedAt?: unknown;
    };
    if (
      typeof stored !== "object" ||
      stored === null ||
      typeof stored.scriptName !== "string"
    ) {
      return undefined;
    }
    const { writeId, updatedAt, ...entry } = stored;
    return {
      entry: entry as RegistryEntry,
      writeId: typeof writeId === "string" ? writeId : undefined,
      updatedAt: typeof updatedAt === "number" ? updatedAt : undefined,
    };
  } catch {
    return undefined;
  }
};

const isFresh = (updatedAt: number | undefined, now: Date) =>
  updatedAt === undefined || updatedAt > now.getTime() - STALE_AFTER_MS;

export const RegistryLive = Layer.effect(
  Registry,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* Paths.state("alchemy", "registry");

    const readEntry = (entry: string) => {
      const entryPath = path.join(directory, entry);
      return Effect.zip(fs.readFileString(entryPath), DateTime.nowAsDate, {
        concurrent: true,
      }).pipe(
        Effect.flatMap(([content, now]) => {
          const parsed = parseStored(content);
          if (!parsed || !isFresh(parsed.updatedAt, now)) {
            return fs.remove(entryPath).pipe(Effect.as(undefined));
          }
          return Effect.succeed([
            decodeURIComponent(path.basename(entry, ".json")),
            parsed.entry,
          ] as const);
        }),
        Effect.orElseSucceed(() => undefined),
      );
    };

    const readAll = fs.readDirectory(directory).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(entries, readEntry, {
          concurrency: "unbounded",
        }),
      ),
      Effect.map((entries) =>
        MutableHashMap.make(...entries.filter((entry) => entry !== undefined)),
      ),
    );

    // Seed the registry with the entries that already exist on disk, so that
    // workers registered before this process started are resolvable
    // immediately (the watcher only reports future changes).
    const ref = yield* SubscriptionRef.make(yield* readAll);

    // Serialize disk snapshots and writes so a poll/watch refresh that started
    // before `write` cannot overwrite the eager in-memory update with a stale
    // empty snapshot.
    const updateLock = yield* Semaphore.make(1);
    const refresh = readAll.pipe(
      Effect.flatMap((newValue) => SubscriptionRef.set(ref, newValue)),
      updateLock.withPermits(1),
    );

    // The `fileSystemSupportsWatcher` flag is set to false on Windows and true everywhere else.
    // The flag can be overridden using a ConfigProvider, e.g. for testing.
    // If the watcher is not supported, we fall back to polling every 100ms.
    yield* (
      (yield* System.fileSystemSupportsWatcher)
        ? fs.watch(directory).pipe(
            Stream.map(() => undefined),
            // Trigger one more read once the watcher is running, to cover
            // changes made between the initial snapshot above and the watcher
            // subscription. `mapEffect` runs the reads sequentially, so a
            // watcher-triggered read cannot be overwritten by an older one.
            Stream.merge(Stream.succeed(undefined)),
            Stream.mapEffect(() => refresh),
          )
        : Stream.fromEffect(refresh).pipe(Stream.repeat(Schedule.spaced(100)))
    ).pipe(Stream.runDrain, Effect.forkScoped);

    return Registry.of({
      read: (subscribers) =>
        SubscriptionRef.get(ref).pipe(
          Effect.map(pickSubscriberServices(subscribers)),
        ),
      subscribe: (subscribers) =>
        SubscriptionRef.changes(ref).pipe(
          Stream.map(pickSubscriberServices(subscribers)),
          Stream.changes,
        ),
      write: (entry) => {
        const entryPath = path.join(
          directory,
          `${encodeURIComponent(entry.scriptName)}.json`,
        );
        return Effect.gen(function* () {
          const writeId = yield* Effect.sync(() =>
            globalThis.crypto.randomUUID(),
          );
          const persist = (updatedAt: number) =>
            JSON.stringify({ ...entry, writeId, updatedAt }, null, 2);
          const now = yield* DateTime.nowAsDate;
          yield* fs.writeFileString(entryPath, persist(now.getTime())).pipe(
            Effect.andThen(
              // Immediately update the in-memory registry so it's available without waiting on IO.
              SubscriptionRef.update(ref, (map) =>
                MutableHashMap.set(map, entry.scriptName, entry),
              ),
            ),
            updateLock.withPermits(1),
          );
          // Remove the entry from the filesystem when the scope closes — but
          // only while the file still holds THIS write's id. A replacement
          // instance of the same script re-registers under the same key; a
          // graceful handoff closes the old scope after the new instance has
          // already overwritten the file, and removing it here would
          // unregister the live replacement.
          yield* Effect.addFinalizer(() =>
            fs.readFileString(entryPath).pipe(
              Effect.flatMap((current) =>
                parseStored(current)?.writeId === writeId
                  ? fs.remove(entryPath)
                  : Effect.void,
              ),
              Effect.ignore,
            ),
          );
          // Rewrite `updatedAt` every 30 seconds so the entry is not
          // considered stale. Skip if a replacement has taken ownership.
          yield* DateTime.nowAsDate.pipe(
            Effect.flatMap((heartbeat) =>
              fs
                .readFileString(entryPath)
                .pipe(
                  Effect.flatMap((current) =>
                    parseStored(current)?.writeId === writeId
                      ? fs.writeFileString(
                          entryPath,
                          persist(heartbeat.getTime()),
                        )
                      : Effect.void,
                  ),
                ),
            ),
            updateLock.withPermits(1),
            Effect.ignore,
            Effect.schedule(Schedule.spaced("30 seconds")),
            Effect.forkScoped,
          );
        }).pipe(
          Effect.mapError(
            (error) =>
              new SystemError({
                subtag: "RegistryWriteError",
                message: "Failed to write registry entry",
                detail: {
                  entry,
                },
                cause: error,
              }),
          ),
        );
      },
    });
  }),
);

const pickSubscriberServices =
  (subscribers: ReadonlyArray<Subscriber>) =>
  (registry: MutableHashMap.MutableHashMap<string, RegistryEntry>) => {
    const resolved: ResolvedTargetMap = {};
    for (const subscriber of subscribers) {
      for (const entry of MutableHashMap.values(registry)) {
        const service = extractSubscriberService(subscriber, entry);
        if (service) {
          resolved[resolvedTargetKey(subscriber)] = {
            ...service,
            scriptName: entry.scriptName,
            debugPortAddress: entry.debugPortAddress,
          };
          break;
        }
      }
    }
    return resolved;
  };

const extractSubscriberService = (
  subscriber: Subscriber,
  entry: RegistryEntry,
) => {
  switch (subscriber.kind) {
    case "worker":
      return entry.scriptName === subscriber.scriptName
        ? entry.services[0]
        : undefined;
    case "durable-object":
      return entry.scriptName === subscriber.scriptName
        ? entry.services.find(
            (service) =>
              service.kind === "durable-object" &&
              service.className === subscriber.className,
          )
        : undefined;
    case "queue-consumer":
      return entry.services.find(
        (service) =>
          service.kind === "queue-consumer" &&
          service.queueName === subscriber.queueName,
      );
    case "workflow":
      return entry.scriptName === subscriber.scriptName
        ? entry.services.find(
            (service) =>
              service.kind === "workflow" &&
              service.workflowName === subscriber.workflowName,
          )
        : undefined;
  }
};
