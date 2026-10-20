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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { connectWorkspace, type WorkspaceHostDescriptor } from "../Containers/WorkspaceObjects.ts";

const toWorkspaceError = (error: unknown) =>
  error instanceof WorkspaceError
    ? error
    : new WorkspaceError({
        message: (error as { readonly message?: string })?.message ?? String(error),
        cause: error,
      });

const unsupported = (what: string) =>
  Effect.fail(
    new WorkspaceError({
      message: `${what} isn't supported by Cloudflare.Containers.Workspace yet`,
    }),
  );

const makeConnection = Effect.fn(function* (descriptor: WorkspaceHostDescriptor) {
  const { sessions, machines } = yield* connectWorkspace(descriptor);
  const connection: WorkspaceConnection = {
    acquire: (session: string, options: WorkspaceOpenOptions) =>
      Effect.gen(function* () {
        if (options.egress && options.egress.length > 0) {
          return yield* unsupported("egress on open");
        }
        const stub = sessions.getByName(session);
        const lease = yield* Effect.acquireRelease(
          stub.acquire(session, "none").pipe(Effect.mapError(toWorkspaceError)),
          (held) => stub.release(session, held.lease).pipe(Effect.ignore),
        );
        // Keep the lease alive for as long as the open runs.
        yield* stub
          .renew(session, lease.lease)
          .pipe(
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
          spawn: () => unsupported("spawn"),
          port: () => unsupported("port"),
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
