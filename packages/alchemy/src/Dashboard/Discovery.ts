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
  const healthy = yield* Effect.tryPromise(async () => {
    const res = await fetch(`${ad.url}/api/health`, {
      signal: AbortSignal.timeout(250),
    });
    return res.ok;
  }).pipe(
    Effect.timeout(Duration.millis(400)),
    Effect.orElseSucceed(() => false),
  );
  return healthy ? ad : undefined;
});
