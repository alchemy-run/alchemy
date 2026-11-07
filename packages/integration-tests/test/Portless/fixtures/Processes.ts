import { run } from "@alchemy.run/portless/internal/Run";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Schedule from "effect/Schedule";

export const isAlive = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });

/** The process group a process belongs to, as `ps` reports it. */
export const processGroupOf = (pid: number) =>
  run(ChildProcess.make("ps", ["-o", "pgid=", "-p", String(pid)])).pipe(
    Effect.map((result) => Number.parseInt(result.stdout.trim(), 10)),
  );

export const waitForDeath = (pid: number) =>
  isAlive(pid).pipe(
    Effect.flatMap((alive) =>
      alive ? Effect.fail(new Error(`pid ${pid} is still alive`)) : Effect.void,
    ),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 50 }),
  );

export interface Route {
  readonly hostname: string;
  readonly port: number;
  readonly pid: number;
  readonly registeredAt?: number;
  readonly childPgid?: number;
  readonly childStartTime?: string;
}

/** The routes file of a Portless state directory, as written. */
export const readRoutes = (stateDirectory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fs
      .readFileString(path.join(stateDirectory, "routes.json"))
      .pipe(Effect.orElseSucceed(() => "[]"));
    return JSON.parse(text) as ReadonlyArray<Route>;
  });

export const routeOf = (stateDirectory: string, hostname: string) =>
  readRoutes(stateDirectory).pipe(
    Effect.map((routes) => routes.find((route) => route.hostname === hostname)),
  );

/** Repeats an effect every 100 ms until the predicate holds, for at most five seconds. */
export const eventually = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  until: (value: A) => boolean,
  description: string,
) =>
  effect.pipe(
    Effect.repeat({ schedule: Schedule.spaced("100 millis"), until, times: 50 }),
    Effect.flatMap((value) =>
      until(value)
        ? Effect.succeed(value)
        : Effect.fail(new Error(`${description} did not happen in time`)),
    ),
  );
