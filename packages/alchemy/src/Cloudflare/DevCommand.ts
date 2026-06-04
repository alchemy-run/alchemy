import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import { ChildProcess } from "effect/unstable/process";
import { AlchemyContext } from "../AlchemyContext.ts";
import { isResolved } from "../Diff.ts";
import * as RpcProvider from "../Local/RpcProvider.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";

export interface DevCommandProps {
  /**
   * Shell command to run as a long-lived dev process (e.g. `npm run dev`).
   */
  command: string;
  /**
   * Working directory for the command. Defaults to `process.cwd()`.
   */
  cwd?: string;
  /**
   * Extra environment variables passed to the command on top of `process.env`.
   */
  env?: Record<string, string | Redacted.Redacted<string>>;
}

/**
 * A long-lived shell process scoped to a stack instance, started during
 * `alchemy dev` and torn down on stack teardown or when its `command` / `cwd`
 * / `env` changes.
 *
 * The provider runs inside the dev sidecar (see `Cloudflare/Local.ts`) so the
 * child process survives user-code HMR — Alchemy's user process can restart
 * without killing your `npm run dev` server.
 *
 * `DevCommand` has no Attributes — the child writes directly to the user's
 * terminal via inherited stdio.
 */
export interface DevCommand extends Resource<
  "Cloudflare.DevCommand",
  DevCommandProps,
  {}
> {}

export const DevCommand = Resource<DevCommand>("Cloudflare.DevCommand");

/**
 * Live-mode no-op. `DevCommand` resources should only be created in dev mode;
 * if one slips into a deploy, this is a noisy no-op rather than a crash.
 */
export const LiveDevCommandProvider = () =>
  Provider.effect(
    DevCommand,
    Effect.succeed(
      DevCommand.Provider.of({
        diff: () => Effect.succeed({ action: "noop" }),
        reconcile: () => Effect.succeed({}),
        delete: () => Effect.void,
      }),
    ),
  );

/**
 * Dev-mode provider. Runs inside the RPC sidecar so the child process
 * outlives user-code restarts. Tracks instances in a module-level closure
 * keyed by resource id; on `reconcile`, it diffs the props hash and either
 * reuses the existing process or interrupts + respawns.
 */
export const LocalDevCommandProvider = () =>
  RpcProvider.effect(
    DevCommand,
    import.meta.resolve(
      // See LocalWorkerProvider — must match the on-disk extension of the
      // sidecar entry file.
      import.meta.url.endsWith(".ts") ? "./Local.ts" : "./Local.js",
      import.meta.url,
    ),
    Effect.gen(function* () {
      // The provider's outer scope lives for the lifetime of the sidecar,
      // which is exactly what we want: child processes get forked into
      // sub-scopes off of this one, so they survive any single user-code
      // restart but die when the sidecar shuts down.
      const rootScope = yield* Effect.scope;

      const instances = new Map<
        string,
        {
          hash: number;
          fiber: Fiber.Fiber<number, any>;
          scope: Scope.Closeable;
        }
      >();

      const spawn = Effect.fn(function* (props: DevCommandProps) {
        const child = yield* ChildProcess.make(props.command, [], {
          shell: true,
          cwd: props.cwd ?? process.cwd(),
          env: {
            ...process.env,
            ...Object.fromEntries(
              Object.entries(props.env ?? {}).map(([k, v]) => [
                k,
                Redacted.isRedacted(v) ? Redacted.value(v) : v,
              ]),
            ),
          },
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        return yield* child.exitCode;
      });

      const stop = Effect.fn(function* (id: string) {
        const existing = instances.get(id);
        if (existing) {
          yield* Fiber.interrupt(existing.fiber);
          yield* Scope.close(existing.scope, Exit.void);
          instances.delete(id);
        }
      });

      return DevCommand.Provider.of({
        diff: Effect.fn(function* ({ id, news }) {
          if (!isResolved(news)) return undefined;
          const hash = Hash.structure(news);
          if (instances.get(id)?.hash === hash) {
            return { action: "noop" };
          }
          return { action: "update" };
        }),
        reconcile: Effect.fn(function* ({ id, news }) {
          const hash = Hash.structure(news);
          const existing = instances.get(id);
          if (existing) {
            if (existing.hash === hash) {
              yield* Effect.log(
                `[${id}] dev command unchanged, reusing process`,
              );
              return {};
            }
            yield* Effect.log(
              `[${id}] dev command changed, restarting process`,
            );
            yield* stop(id);
          }
          // Fork a fresh sub-scope off the long-lived root scope. The
          // ChildProcess + its exit fiber are scoped here, so closing
          // this scope kills the process.
          const scope = yield* Scope.fork(rootScope);
          const fiber = yield* spawn(news).pipe(
            Effect.forkDetach,
            Scope.provide(scope),
          );
          instances.set(id, { hash, fiber, scope });
          return {};
        }),
        delete: Effect.fn(function* ({ id }) {
          yield* stop(id);
        }),
      });
    }),
  );

/**
 * Selects the live or dev DevCommand provider based on `AlchemyContext.dev`.
 */
export const DevCommandProvider = () =>
  Layer.unwrap(
    AlchemyContext.useSync((context) =>
      context.dev ? LocalDevCommandProvider() : LiveDevCommandProvider(),
    ),
  );
