import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Local dashboard discovery: `alchemy dashboard` advertises itself in
 * `.alchemy/dashboard.json` (project-scoped, next to local state); other
 * alchemy processes in the same project (deploy/destroy) look it up to
 * stream apply events. The file is removed when the dashboard's scope
 * closes; a stale file is handled by the health check.
 */
export interface DashboardAdvertisement {
  url: string;
  pid: number;
  stack: string;
  stage: string;
  startedAt: string;
}

const advertisementFile = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(process.cwd(), ".alchemy", "dashboard.json");
});

/**
 * Deterministic per-project dashboard port (42000–42999): every `--ui` run
 * of the same project lands on the SAME origin, so a browser tab from a
 * previous run simply reconnects instead of a new tab opening on a random
 * port.
 */
export const stablePort = (stack: string): number => {
  const key = `${process.cwd()}#${stack}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return 42000 + ((hash >>> 0) % 1000);
};

/** Shape of the dashboard's /api/health response. */
interface HealthBody {
  ok?: boolean;
  stack?: string;
  /** live SSE subscriber count — 0 means no tab is currently connected */
  clients?: number;
}

const fetchHealth = (url: string) =>
  Effect.tryPromise(async () => {
    const res = await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(300),
    });
    if (!res.ok) {
      return undefined;
    }
    return (await res.json().catch(() => undefined)) as HealthBody | undefined;
  }).pipe(
    Effect.timeout(Duration.millis(500)),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * What is listening on a candidate port:
 * - `free` — nothing (connection refused): safe to bind
 * - `ours` — an alchemy dashboard for this stack: reuse it (`clients` says
 *   whether a browser tab is already attached)
 * - `foreign` — some other process: fall back to a random port
 */
export const probePort = Effect.fn(function* (port: number, stack: string) {
  const listening = yield* Effect.tryPromise(async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(300),
    });
    if (!res.ok) {
      return { kind: "foreign" } as const;
    }
    const body = (await res.json().catch(() => undefined)) as
      | HealthBody
      | undefined;
    return body?.ok === true && body.stack === stack
      ? ({
          kind: "ours",
          url: `http://127.0.0.1:${port}`,
          clients: body.clients ?? 0,
        } as const)
      : ({ kind: "foreign" } as const);
  }).pipe(
    Effect.timeout(Duration.millis(500)),
    // fetch throwing = connection refused = nothing is listening
    Effect.orElseSucceed(() => ({ kind: "free" }) as const),
  );
  return listening;
});

/**
 * Advertise a running dashboard for the lifetime of the current scope.
 */
export const advertise = Effect.fn(function* (
  ad: Omit<DashboardAdvertisement, "pid" | "startedAt">,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* advertisementFile;
  yield* fs
    .makeDirectory(path.dirname(file), { recursive: true })
    .pipe(Effect.orElseSucceed(() => undefined));
  const payload: DashboardAdvertisement = {
    ...ad,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  yield* fs.writeFileString(file, JSON.stringify(payload, null, 2));
  yield* Effect.addFinalizer(() =>
    fs.remove(file).pipe(Effect.orElseSucceed(() => undefined)),
  );
});

/**
 * Find a live dashboard for this project: read the advertisement and
 * health-check it with a tight budget so deploys never stall on a stale
 * file. Returns undefined when no (healthy) dashboard is running.
 */
export const discover = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* advertisementFile;
  const content = yield* fs
    .readFileString(file)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (content === undefined) {
    return undefined;
  }
  const ad = yield* Effect.try(
    () => JSON.parse(content) as DashboardAdvertisement,
  ).pipe(Effect.orElseSucceed(() => undefined));
  if (ad === undefined) {
    return undefined;
  }
  const health = yield* fetchHealth(ad.url);
  if (health?.ok !== true) {
    return undefined;
  }
  return { ...ad, clients: health.clients ?? 0 };
});
