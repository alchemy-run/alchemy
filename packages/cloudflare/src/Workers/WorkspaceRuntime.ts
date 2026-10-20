import { SandboxError, type SandboxPort, type SandboxProcess } from "@alchemy.run/sandbox/Sandbox";
/**
 * A workspace from a Worker or Durable Object: leases and commands through
 * the Durable Objects its host Worker serves (`Cloudflare.Containers.Workspace`).
 * Provided to every Worker and Durable Object as the `Sandbox.WorkspaceRuntime`.
 *
 * NOT exported from `index.ts`.
 */
import {
  WorkspaceError,
  WorkspaceRuntime,
  type WorkspaceConnection,
  type WorkspaceExecOptions,
  type WorkspaceOpenOptions,
  type WorkspaceSession,
} from "@alchemy.run/sandbox/Workspace";
import { canonicalJson } from "alchemy/Egress/Canonical";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import {
  connectWorkspace,
  type DelegatedEgress,
  type WorkspaceHostDescriptor,
} from "../Containers/WorkspaceObjects.ts";
import { toHttpClient } from "../Fetcher.ts";

/** How long the grants an open mints live; they're minted again well before. */
const EGRESS_TTL = Duration.minutes(5);
/** Lease renewals between mints. */
const MINT_EVERY = 4;

const toWorkspaceError = (error: unknown) =>
  error instanceof WorkspaceError
    ? error
    : new WorkspaceError({
        message: (error as { readonly message?: string })?.message ?? String(error),
        cause: error,
      });

/** How often a spawned process's output is polled. */
const POLL = Duration.millis(200);

/**
 * A process the machine runs in the background: its output and exit code
 * are polled from files in the container, so nothing streams over RPC.
 */
const spawned = (
  machine: {
    read: (
      id: string,
      stream: "out" | "err",
      offset: number,
    ) => Effect.Effect<
      { readonly data: Uint8Array; readonly exitCode: number | undefined },
      WorkspaceError,
      RuntimeContext
    >;
    kill: (id: string, signal: number) => Effect.Effect<void, WorkspaceError, RuntimeContext>;
  },
  process: { readonly id: string; readonly pid: number },
): SandboxProcess => {
  const toSandboxError = (error: unknown) =>
    new SandboxError({ message: (error as Error)?.message ?? String(error), cause: error });
  const follow = (stream: "out" | "err") =>
    Stream.unfold({ offset: 0, done: false }, (cursor) =>
      cursor.done
        ? Effect.succeed(undefined)
        : machine.read(process.id, stream, cursor.offset).pipe(
            Effect.flatMap((chunk) =>
              chunk.data.length === 0 && chunk.exitCode === undefined
                ? Effect.as(Effect.sleep(POLL), [new Uint8Array(0), cursor] as const)
                : Effect.succeed([
                    chunk.data,
                    {
                      offset: cursor.offset + chunk.data.length,
                      // Read once more after the exit: output written before it.
                      done: chunk.exitCode !== undefined && chunk.data.length === 0,
                    },
                  ] as const),
            ),
            Effect.mapError(toSandboxError),
          ),
    ).pipe(Stream.filter((bytes) => bytes.length > 0));
  const exitCode = machine.read(process.id, "out", Number.MAX_SAFE_INTEGER).pipe(
    Effect.flatMap((chunk) =>
      chunk.exitCode === undefined
        ? Effect.fail("running" as const)
        : Effect.succeed(chunk.exitCode),
    ),
    Effect.retry({ while: (error) => error === "running", schedule: Schedule.spaced(POLL) }),
    Effect.mapError(toSandboxError),
  );
  const collect = (stream: "out" | "err") =>
    Stream.runFold(
      follow(stream),
      () => new Uint8Array(0),
      (all, chunk) => {
        const next = new Uint8Array(all.length + chunk.length);
        next.set(all);
        next.set(chunk, all.length);
        return next;
      },
    );
  return {
    pid: process.pid,
    isPty: false,
    stdin: undefined,
    stdout: follow("out"),
    stderr: follow("err"),
    exitCode,
    output: () =>
      Effect.all([collect("out"), collect("err"), exitCode], { concurrency: "unbounded" }).pipe(
        Effect.map(([stdout, stderr, code]) => ({
          stdout: stdout.buffer as ArrayBuffer,
          stderr: stderr.buffer as ArrayBuffer,
          exitCode: code,
        })),
      ),
    kill: (signal = 15) => machine.kill(process.id, signal).pipe(Effect.mapError(toSandboxError)),
    resize: () => Effect.void,
  } as unknown as SandboxProcess;
};

const makeConnection = Effect.fn(function* (descriptor: WorkspaceHostDescriptor) {
  const { sessions, machines } = yield* connectWorkspace(descriptor);
  const connection: WorkspaceConnection = {
    acquire: (session: string, options: WorkspaceOpenOptions) =>
      Effect.gen(function* () {
        const egress = options.egress ?? [];
        // This Worker's gateway clients mint the open's grants; the host
        // has none of its own.
        const mint: Effect.Effect<DelegatedEgress | undefined, WorkspaceError, any> =
          egress.length === 0
            ? Effect.succeed(undefined)
            : Effect.promise(() => import("alchemy/Egress/Gateway")).pipe(
                Effect.flatMap(({ grant }) => grant(egress, { ttl: EGRESS_TTL })),
                Effect.map((granted): DelegatedEgress => ({
                  refs: egress.map((e) => e.ref),
                  minted: granted.minted,
                  ttlMs: Duration.toMillis(EGRESS_TTL),
                })),
                Effect.mapError(toWorkspaceError),
              );
        const grantKey = egress.length === 0 ? "" : canonicalJson(egress.map((e) => e.ref));
        const stub = sessions.getByName(session);
        const first = yield* mint;
        const lease = yield* Effect.acquireRelease(
          stub
            .acquire(session, grantKey, first, descriptor.url)
            .pipe(Effect.mapError(toWorkspaceError)),
          (held) => stub.release(session, held.lease).pipe(Effect.ignore),
        );
        // Keep the lease (and the grants) alive for as long as the open runs.
        let renewals = 0;
        yield* Effect.suspend(() =>
          (++renewals % MINT_EVERY === 0 ? mint : Effect.succeed(undefined)).pipe(
            Effect.flatMap((fresh) => stub.renew(session, lease.lease, fresh)),
          ),
        ).pipe(
          Effect.ignore,
          Effect.repeat(Schedule.spaced(Duration.seconds(30))),
          Effect.forkScoped,
        );
        const machine = machines.getByName(lease.machine);
        return {
          name: session,
          exec: (command: string, execOptions: WorkspaceExecOptions = {}) =>
            machine
              .exec(command, {
                cwd: execOptions.cwd ?? lease.dir,
                ...(execOptions.env ? { env: execOptions.env } : {}),
                ...(execOptions.timeout !== undefined
                  ? {
                      timeoutMs: Duration.toMillis(Duration.fromInputUnsafe(execOptions.timeout)),
                    }
                  : {}),
              })
              .pipe(Effect.mapError(toWorkspaceError)),
          spawn: (command: string, spawnOptions: WorkspaceExecOptions = {}) =>
            Effect.gen(function* () {
              const started = yield* Effect.acquireRelease(
                machine
                  .spawn(command, {
                    cwd: spawnOptions.cwd ?? lease.dir,
                    ...(spawnOptions.env ? { env: spawnOptions.env } : {}),
                  })
                  .pipe(Effect.mapError(toWorkspaceError)),
                // Closing the scope kills the process.
                (process) => machine.kill(process.id, 15).pipe(Effect.ignore),
              );
              return spawned(machine, started);
            }),
          port: (port: number) =>
            Effect.succeed({
              fetch: (request) =>
                toHttpClient(machine as never)
                  .execute(HttpClientRequest.setHeader(request, "x-alchemy-port", String(port)))
                  .pipe(
                    Effect.mapError((error) =>
                      error._tag === "HttpClientError"
                        ? error
                        : new SandboxError({ message: String(error), cause: error }),
                    ),
                  ),
            } satisfies SandboxPort),
        } satisfies WorkspaceSession;
      }),
    fork: (from, to) =>
      sessions.getByName(to).fork(to, from).pipe(Effect.mapError(toWorkspaceError)),
    undo: (session, steps = 1) =>
      sessions.getByName(session).undo(session, steps).pipe(Effect.mapError(toWorkspaceError)),
    history: (session, options = {}) =>
      sessions
        .getByName(session)
        .history(session, options.limit ?? 20)
        .pipe(Effect.mapError(toWorkspaceError)),
    delete: (session) =>
      sessions.getByName(session).remove(session).pipe(Effect.mapError(toWorkspaceError)),
  };
  return connection;
});

/** At deploy the descriptor is an unresolved Output: nothing runs then. */
const deployTime: WorkspaceConnection = {
  acquire: () => Effect.die(new Error("a workspace can't be opened at deploy")),
  fork: () => Effect.die(new Error("a workspace can't be forked at deploy")),
  undo: () => Effect.die(new Error("a workspace can't be undone at deploy")),
  history: () => Effect.die(new Error("a workspace has no history at deploy")),
  delete: () => Effect.die(new Error("a workspace can't be deleted at deploy")),
};

/** Provide `Sandbox.WorkspaceRuntime` to a Worker's or Durable Object's constructor. */
export const provideWorkspaceRuntime = <A, E, R>(
  constructor: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, WorkspaceRuntime>> =>
  Effect.flatMap(Effect.context<never>(), (services) =>
    Effect.provideService(constructor, WorkspaceRuntime, {
      connect: (_id, descriptor) =>
        globalThis.__ALCHEMY_RUNTIME__
          ? makeConnection(descriptor as WorkspaceHostDescriptor).pipe(
              Effect.provide(services as never),
            )
          : Effect.succeed(deployTime),
    }),
  );
