import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import { Path } from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import { rootDir } from "../Auth/Paths.ts";
import packageJson from "../../package.json" with { type: "json" };

/** Logs older than this are pruned (by mtime) on CLI start. */
const MAX_LOG_AGE = Duration.days(7);

/**
 * The console keeps its usual Info+ noise floor; everything below it exists
 * only for the run log, so support requests can start with "attach the file
 * from ~/.alchemy/logs".
 */
const consoleInfoLogger = Logger.make<unknown, void>((options) => {
  if (LogLevel.isGreaterThanOrEqualTo(options.logLevel, "Info")) {
    Logger.defaultLogger.log(options);
  }
});

/** Drops everything — the fallback when the log file cannot be opened. */
const noopLogger = Logger.make<unknown, void>(() => {});

/**
 * Debug run log for the whole CLI under `~/.alchemy/logs` (relocated by
 * `ALCHEMY_HOME` together with the rest of the auth state). Every run writes
 * `{timestamp}-pid{pid}.log` in logfmt at Debug level — profile/auth flows
 * and command failures record their full causes there even though the
 * terminal only shows the friendly message. Console output stays at Info+.
 *
 * Commands that install their own loggers with `mergeWithExisting: true`
 * compose with this one; a replacing `Logger.layer` scopes it out for that
 * subtree only. Best-effort throughout: an unwritable `~/.alchemy` must
 * never take the CLI down with it.
 */
export const GlobalLogLive = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path;
    const dir = path.join(rootDir(), "logs");
    yield* fs.makeDirectory(dir, { recursive: true });

    // Prune stale run logs so the directory stays bounded.
    const now = Date.now();
    const entries = yield* fs
      .readDirectory(dir)
      .pipe(Effect.catch(() => Effect.succeed([] as string[])));
    yield* Effect.forEach(
      entries,
      (entry) =>
        Effect.gen(function* () {
          const file = path.join(dir, entry);
          const info = yield* fs.stat(file);
          const mtime = Option.getOrUndefined(info.mtime)?.getTime();
          if (
            mtime !== undefined &&
            now - mtime > Duration.toMillis(MAX_LOG_AGE)
          ) {
            yield* fs.remove(file);
          }
        }).pipe(Effect.ignore),
      { discard: true },
    );

    const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
    const file = path.join(dir, `${stamp}-pid${process.pid}.log`);
    return Layer.mergeAll(
      Logger.layer([
        consoleInfoLogger,
        Logger.formatLogFmt.pipe(
          Logger.toFile(file, { flag: "a" }),
          Effect.catch(() => Effect.succeed(noopLogger)),
        ),
      ]),
      Layer.succeed(MinimumLogLevel, "Debug"),
    );
  }).pipe(Effect.catch(() => Effect.succeed(Layer.empty))),
);

/** First line of every run log: enough context to read it standalone. */
export const logRunHeader: Effect.Effect<void> = Effect.logDebug(
  `alchemy ${packageJson.version} pid=${process.pid} cwd=${process.cwd()} argv=${JSON.stringify(process.argv.slice(2))}`,
);
