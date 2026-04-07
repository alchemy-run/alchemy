import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import {
  ChildProcessSpawner,
  type ChildProcessHandle,
} from "effect/unstable/process/ChildProcessSpawner";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import {
  ALCHEMY_DIR,
  DB_FILE,
  ensureAlchemyDir,
  LOCK_DIR_NAME,
  PID_FILE_NAME,
  PROCESSES_DIR,
  resolveSocketPath,
  SOCKET_FILE,
} from "./Config.ts";
import {
  DaemonAlreadyRunning,
  ProcessAlreadyExists,
  ProcessNotFound,
} from "./Errors.ts";
import { DaemonRpcs } from "./RpcSchema.ts";
import { type SQLiteConnection } from "../SQLite/index.ts";
import { SQLite } from "../SQLite/SQLite.ts";

const STALE_THRESHOLD = Duration.seconds(10);
const LOCK_UPDATE_INTERVAL = Duration.seconds(4);
const IDLE_TIMEOUT = Duration.seconds(10);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isProcessAlive = (pid: number): Effect.Effect<boolean> =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });

// ---------------------------------------------------------------------------
// Lock — mkdir strategy with mtime-based staleness
// ---------------------------------------------------------------------------

const readLockPid = (lockDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pidFile = path.join(lockDir, PID_FILE_NAME);
    const contents = yield* fs
      .readFileString(pidFile)
      .pipe(Effect.catchTag("PlatformError", () => Effect.succeed("")));
    const pid = parseInt(contents.trim(), 10);
    return isNaN(pid) ? undefined : pid;
  });

const isLockStale = (pidFile: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs
      .stat(pidFile)
      .pipe(Effect.catchTag("PlatformError", () => Effect.succeed(undefined)));
    if (info === undefined) return true;
    const mtime = Option.getOrElse(info.mtime, () => new Date(0));
    const age = Date.now() - mtime.getTime();
    return age > Duration.toMillis(STALE_THRESHOLD);
  });

const startLockUpdater = (
  lockDir: string,
  shutdownSignal: Deferred.Deferred<void>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pidFile = path.join(lockDir, PID_FILE_NAME);
    const lastMtime = yield* Ref.make<number>(Date.now());

    const touch = Effect.gen(function* () {
      const info = yield* fs
        .stat(pidFile)
        .pipe(
          Effect.catchTag("PlatformError", () => Effect.succeed(undefined)),
        );

      if (info === undefined) {
        yield* Effect.logError("Lock compromised: pid file disappeared");
        yield* Deferred.succeed(shutdownSignal, void 0);
        return;
      }

      const currentMtime = Option.getOrElse(info.mtime, () => new Date(0));
      const expected = yield* Ref.get(lastMtime);

      if (Math.abs(currentMtime.getTime() - expected) > 1000) {
        yield* Effect.logError(
          `Lock compromised: mtime changed externally (expected ${expected}, got ${currentMtime.getTime()})`,
        );
        yield* Deferred.succeed(shutdownSignal, void 0);
        return;
      }

      const now = new Date();
      yield* fs.utimes(pidFile, now, now).pipe(
        Effect.catchTag("PlatformError", (err) => {
          Effect.logWarning(`Failed to update lock mtime: ${err.message}`);
          return Effect.void;
        }),
      );
      yield* Ref.set(lastMtime, now.getTime());
    });

    return yield* touch.pipe(
      Effect.repeat(Schedule.spaced(LOCK_UPDATE_INTERVAL)),
      Effect.asVoid,
      Effect.forkChild,
    );
  });

const acquireLock = (shutdownSignal: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* ensureAlchemyDir;
    const lockDir = path.join(dir, LOCK_DIR_NAME);
    const pidFile = path.join(lockDir, PID_FILE_NAME);

    const tryMkdir = Effect.gen(function* () {
      yield* fs.makeDirectory(lockDir);
      yield* fs.writeFileString(pidFile, String(process.pid));
    });

    yield* tryMkdir.pipe(
      Effect.catchTag("PlatformError", (err) => {
        if (err.reason._tag !== "AlreadyExists") return Effect.fail(err);

        return Effect.gen(function* () {
          const stale = yield* isLockStale(pidFile);
          if (!stale) {
            const pid = yield* readLockPid(lockDir);
            return yield* new DaemonAlreadyRunning({ pid });
          }

          const pid = yield* readLockPid(lockDir);
          if (pid !== undefined) {
            const alive = yield* isProcessAlive(pid);
            if (alive) {
              return yield* new DaemonAlreadyRunning({ pid });
            }
          }

          yield* Effect.logWarning(
            `Removing stale lock (previous pid: ${pid ?? "unknown"})`,
          );
          yield* fs.remove(lockDir, { recursive: true, force: true });

          yield* tryMkdir.pipe(
            Effect.catchTag("PlatformError", (retryErr) =>
              retryErr.reason._tag !== "AlreadyExists"
                ? Effect.fail<DaemonAlreadyRunning | typeof retryErr>(retryErr)
                : Effect.gen(function* () {
                    const winnerPid = yield* readLockPid(lockDir);
                    return yield* new DaemonAlreadyRunning({ pid: winnerPid });
                  }),
            ),
          );
        });
      }),
    );

    const updaterFiber = yield* startLockUpdater(lockDir, shutdownSignal);

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Fiber.interrupt(updaterFiber).pipe(Effect.ignore);
        yield* fs
          .remove(lockDir, { recursive: true, force: true })
          .pipe(Effect.ignore);
      }),
    );
  });

// ---------------------------------------------------------------------------
// Socket lifecycle
// ---------------------------------------------------------------------------

const cleanStaleSocket = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.resolve(ALCHEMY_DIR);
  const socketPath = path.join(dir, SOCKET_FILE);
  yield* fs.remove(socketPath, { force: true });
});

// ---------------------------------------------------------------------------
// SQLite — process metadata persistence
// ---------------------------------------------------------------------------

const initDb = Effect.gen(function* () {
  const sqlite = yield* SQLite;
  const path = yield* Path.Path;
  const dir = yield* ensureAlchemyDir;
  const dbPath = path.join(dir, DB_FILE);
  const db = yield* sqlite.open(dbPath);

  yield* db.exec(`
    CREATE TABLE IF NOT EXISTS processes (
      id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      command TEXT NOT NULL,
      args TEXT NOT NULL,
      cwd TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  return db;
});

interface ProcessRow {
  id: string;
  pid: number;
  command: string;
  args: string;
  cwd: string | null;
}

// ---------------------------------------------------------------------------
// Boot cleanup — kill orphans from a previous crashed daemon
// ---------------------------------------------------------------------------

const cleanupOrphans = (db: SQLiteConnection) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* ensureAlchemyDir;
    const processesDir = path.join(dir, PROCESSES_DIR);

    const stmt = yield* db.prepare<ProcessRow>("SELECT id, pid FROM processes");
    const orphans = yield* stmt.all();

    if (orphans.length === 0) return;

    yield* Effect.logInfo(`Cleaning up ${orphans.length} orphan process(es)…`);

    for (const orphan of orphans) {
      yield* isProcessAlive(orphan.pid).pipe(
        Effect.flatMap((alive) =>
          alive
            ? Effect.sync(() => {
                try {
                  process.kill(orphan.pid, "SIGKILL");
                } catch {}
              })
            : Effect.void,
        ),
      );

      yield* fs
        .remove(path.join(processesDir, orphan.id), {
          recursive: true,
          force: true,
        })
        .pipe(Effect.ignore);
    }

    const delStmt = yield* db.prepare("DELETE FROM processes");
    yield* delStmt.run();

    yield* Effect.logInfo(`Cleaned up ${orphans.length} orphan(s)`);
  });

// ---------------------------------------------------------------------------
// Process Registry
// ---------------------------------------------------------------------------

interface OutputMessage {
  readonly fd: "stdout" | "stderr";
  readonly text: string;
}

interface ManagedProcess {
  readonly id: string;
  readonly handle: ChildProcessHandle;
  readonly pubsub: PubSub.PubSub<OutputMessage>;
  readonly stdoutLogPath: string;
  readonly stderrLogPath: string;
  readonly cursors: Ref.Ref<
    HashMap.HashMap<string, { stdoutOffset: number; stderrOffset: number }>
  >;
}

type Registry = Ref.Ref<HashMap.HashMap<string, ManagedProcess>>;

const makeProcessRegistry = (db: SQLiteConnection, daemonScope: Scope.Scope) =>
  Effect.gen(function* () {
    const registry: Registry = yield* Ref.make(
      HashMap.empty<string, ManagedProcess>(),
    );

    const fs = yield* FileSystem.FileSystem;
    const pathSvc = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner;
    const alchemyDir = yield* ensureAlchemyDir;
    const processesDir = pathSvc.join(alchemyDir, PROCESSES_DIR);
    yield* fs.makeDirectory(processesDir, { recursive: true });

    const spawnProcess = (req: {
      id: string;
      command: string;
      args: ReadonlyArray<string>;
      cwd?: string;
      env?: Record<string, string>;
    }) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(registry);
        const existing = HashMap.get(current, req.id);

        if (Option.isSome(existing)) {
          const alive = yield* existing.value.handle.isRunning;
          if (alive) {
            return yield* Effect.fail(new ProcessAlreadyExists({ id: req.id }));
          }
          yield* Ref.update(registry, HashMap.remove(req.id));
        }

        const logDir = pathSvc.join(processesDir, req.id);
        yield* fs.makeDirectory(logDir, { recursive: true });
        const stdoutLogPath = pathSvc.join(logDir, "stdout.log");
        const stderrLogPath = pathSvc.join(logDir, "stderr.log");

        yield* fs
          .writeFile(stdoutLogPath, new Uint8Array(0))
          .pipe(Effect.ignore);
        yield* fs
          .writeFile(stderrLogPath, new Uint8Array(0))
          .pipe(Effect.ignore);

        const cmd = ChildProcess.make(req.command, req.args as string[], {
          cwd: req.cwd,
          env: req.env,
        });
        const childScope = yield* Scope.make();
        const handle = yield* Scope.provide(spawner.spawn(cmd), childScope);

        const insertStmt = yield* db.prepare(
          "INSERT OR REPLACE INTO processes (id, pid, command, args, cwd) VALUES (?, ?, ?, ?, ?)",
        );
        yield* insertStmt.run(
          req.id,
          handle.pid,
          req.command,
          JSON.stringify(req.args),
          req.cwd ?? null,
        );

        const pubsub = yield* PubSub.unbounded<OutputMessage>();
        const cursors = yield* Ref.make(
          HashMap.empty<
            string,
            { stdoutOffset: number; stderrOffset: number }
          >(),
        );

        const collectStream = (
          stream: Stream.Stream<Uint8Array, any>,
          fd: "stdout" | "stderr",
          logPath: string,
        ) =>
          Effect.scoped(
            Effect.gen(function* () {
              const logFile = yield* fs.open(logPath, { flag: "a" });

              yield* stream.pipe(
                Stream.runForEach((chunk) =>
                  Effect.gen(function* () {
                    yield* logFile.writeAll(chunk);
                    const text = new TextDecoder().decode(chunk);
                    yield* PubSub.publish(pubsub, { fd, text });
                  }),
                ),
                Effect.ignore,
              );
            }),
          );

        yield* collectStream(handle.stdout, "stdout", stdoutLogPath).pipe(
          Effect.forkDetach,
        );
        yield* collectStream(handle.stderr, "stderr", stderrLogPath).pipe(
          Effect.forkDetach,
        );

        const managed: ManagedProcess = {
          id: req.id,
          handle,
          pubsub,
          stdoutLogPath,
          stderrLogPath,
          cursors,
        };

        yield* Ref.update(registry, HashMap.set(req.id, managed));

        return { pid: handle.pid };
      });

    const killProcess = (req: { id: string; killSignal?: string }) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(registry);
        const existing = HashMap.get(current, req.id);

        if (Option.isNone(existing)) {
          return yield* Effect.fail(new ProcessNotFound({ id: req.id }));
        }

        const proc = existing.value;
        yield* proc.handle
          .kill(
            req.killSignal
              ? { killSignal: req.killSignal as ChildProcess.Signal }
              : undefined,
          )
          .pipe(Effect.ignore);
        yield* proc.handle.exitCode.pipe(Effect.ignore);

        const delStmt = yield* db.prepare("DELETE FROM processes WHERE id = ?");
        yield* delStmt.run(req.id);

        yield* Ref.update(registry, HashMap.remove(req.id));
      });

    const watchProcess = (req: { id: string; clientId: string }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const current = yield* Ref.get(registry);
          const existing = HashMap.get(current, req.id);

          if (Option.isNone(existing)) {
            return yield* Effect.fail(new ProcessNotFound({ id: req.id }));
          }

          const proc = existing.value;

          const allCursors = yield* Ref.get(proc.cursors);
          const cursor = Option.getOrElse(
            HashMap.get(allCursors, req.clientId),
            () => ({ stdoutOffset: 0, stderrOffset: 0 }),
          );

          const replayFile = (
            logPath: string,
            fd: "stdout" | "stderr",
            offset: number,
          ) =>
            Effect.gen(function* () {
              const content = yield* fs
                .readFile(logPath)
                .pipe(
                  Effect.catchTag("PlatformError", () =>
                    Effect.succeed(new Uint8Array(0)),
                  ),
                );
              if (offset >= content.byteLength)
                return { messages: [] as OutputMessage[], newOffset: offset };
              const chunk = content.slice(offset);
              const text = new TextDecoder().decode(chunk);
              return {
                messages: [{ fd, text } as OutputMessage],
                newOffset: content.byteLength,
              };
            });

          const stdoutReplay = yield* replayFile(
            proc.stdoutLogPath,
            "stdout",
            cursor.stdoutOffset,
          );
          const stderrReplay = yield* replayFile(
            proc.stderrLogPath,
            "stderr",
            cursor.stderrOffset,
          );

          const replayMessages = [
            ...stdoutReplay.messages,
            ...stderrReplay.messages,
          ].filter((m) => m.text.length > 0);

          const cursorUpdate = Stream.fromEffect(
            Effect.as(
              Ref.update(
                proc.cursors,
                HashMap.set(req.clientId, {
                  stdoutOffset: stdoutReplay.newOffset,
                  stderrOffset: stderrReplay.newOffset,
                }),
              ),
              undefined as never,
            ),
          ).pipe(Stream.filter((_): _ is never => false));

          const replayStream = Stream.concat(
            Stream.fromIterable(replayMessages),
            cursorUpdate,
          );

          const isRunning = yield* proc.handle.isRunning.pipe(
            Effect.catchTag("PlatformError", () => Effect.succeed(false)),
          );

          if (!isRunning) {
            return replayStream;
          }

          const liveStream = Stream.fromPubSub(proc.pubsub).pipe(
            Stream.tap((msg) =>
              Ref.update(proc.cursors, (cursorsMap) => {
                const cur = Option.getOrElse(
                  HashMap.get(cursorsMap, req.clientId),
                  () => ({
                    stdoutOffset: cursor.stdoutOffset,
                    stderrOffset: cursor.stderrOffset,
                  }),
                );
                const byteLen = new TextEncoder().encode(msg.text).byteLength;
                return HashMap.set(cursorsMap, req.clientId, {
                  stdoutOffset:
                    cur.stdoutOffset + (msg.fd === "stdout" ? byteLen : 0),
                  stderrOffset:
                    cur.stderrOffset + (msg.fd === "stderr" ? byteLen : 0),
                });
              }),
            ),
          );

          return Stream.concat(replayStream, liveStream);
        }),
      );

    return { registry, spawnProcess, killProcess, watchProcess };
  });

// ---------------------------------------------------------------------------
// Idle shutdown — heartbeat-based
// ---------------------------------------------------------------------------

const makeIdleWatchdog = (shutdownSignal: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    const lastHeartbeat = yield* Ref.make(Date.now());

    const recordHeartbeat = Ref.set(lastHeartbeat, Date.now());

    const startWatchdog = Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* Effect.sleep(IDLE_TIMEOUT);
        const last = yield* Ref.get(lastHeartbeat);
        const elapsed = Date.now() - last;
        if (elapsed >= Duration.toMillis(IDLE_TIMEOUT)) {
          yield* Effect.logInfo("No heartbeat received — shutting down daemon");
          yield* Deferred.succeed(shutdownSignal, void 0);
        }
      }).pipe(
        Effect.repeat(Schedule.spaced(IDLE_TIMEOUT)),
        Effect.asVoid,
        Effect.forkChild,
      );
    });

    const awaitShutdown = Deferred.await(shutdownSignal);

    return { recordHeartbeat, startWatchdog, awaitShutdown };
  });

// ---------------------------------------------------------------------------
// RPC handler layer
// ---------------------------------------------------------------------------

const makeHandlersLayer = (
  watchdog: Effect.Success<ReturnType<typeof makeIdleWatchdog>>,
  procRegistry: Effect.Success<ReturnType<typeof makeProcessRegistry>>,
) =>
  DaemonRpcs.toLayer({
    heartbeat: () =>
      Effect.gen(function* () {
        yield* Effect.logInfo("Heartbeat received");
        yield* watchdog.recordHeartbeat;
      }),
    spawn: (req) =>
      procRegistry.spawnProcess(req).pipe(
        Effect.catchIf(
          (e): e is Exclude<typeof e, ProcessAlreadyExists> =>
            !(e instanceof ProcessAlreadyExists),
          (e) => Effect.die(e),
        ),
      ),
    kill: (req) =>
      procRegistry.killProcess(req).pipe(
        Effect.catchIf(
          (e): e is Exclude<typeof e, ProcessNotFound> =>
            !(e instanceof ProcessNotFound),
          (e) => Effect.die(e),
        ),
      ),
    watch: (req) => procRegistry.watchProcess(req),
  });

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export const main = Effect.gen(function* () {
  const shutdownSignal = yield* Deferred.make<void>();

  yield* Effect.logInfo("Acquiring daemon lock…");
  yield* acquireLock(shutdownSignal);

  const db = yield* initDb;
  yield* cleanupOrphans(db);

  yield* cleanStaleSocket;

  const socketPath = yield* resolveSocketPath;
  yield* Effect.logInfo("Starting daemon socket server…");

  const socketServerLayer = NodeSocketServer.layer({ path: socketPath });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(socketPath, { force: true }).pipe(Effect.ignore);
    }),
  );

  const watchdog = yield* makeIdleWatchdog(shutdownSignal);
  yield* watchdog.startWatchdog;
  yield* watchdog.recordHeartbeat;

  const scope = yield* Effect.scope;
  const procRegistry = yield* makeProcessRegistry(db, scope);

  const rpcServerLayer = RpcServer.layer(DaemonRpcs).pipe(
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(socketServerLayer),
    Layer.provide(makeHandlersLayer(watchdog, procRegistry)),
    Layer.provide(NodeServices.layer),
    Layer.provide(BunSQLite),
  );

  yield* Layer.launch(rpcServerLayer).pipe(Effect.forkScoped);

  yield* Effect.logInfo("Daemon ready");

  yield* watchdog.awaitShutdown;
}).pipe(Effect.scoped);

// Re-export platform layers needed by the entry point
import * as NodeServices from "@effect/platform-node/NodeServices";
import { BunSQLite } from "../SQLite/index.ts";

export { BunSQLite, NodeServices };
