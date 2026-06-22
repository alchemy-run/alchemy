import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";
import {
  ChildProcessSpawner,
  type ChildProcessHandle,
} from "effect/unstable/process/ChildProcessSpawner";
import { AlchemyContext } from "../AlchemyContext.ts";
import { isResolved } from "../Diff.ts";
import * as RpcProvider from "../Local/RpcProvider.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";

export interface DevServerProps {
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
 * `alchemy dev`, restarted when inputs are changes.
 *
 * The provider runs inside the dev sidecar (see `Build/Local.ts`) so the
 * child process survives user-code HMR — Alchemy's user process can restart
 * without killing your `npm run dev` server. During deploy this performs a no-op
 *
 * The child's stdout/stderr are mirrored to the sidecar's terminal so the
 * user still sees colored dev-server output, and each line is scanned for
 * the first `http(s)://…` URL. The first match (with ANSI escapes stripped)
 * is exposed as `url` — useful for surfacing a dev server's local URL back
 * out to whatever resource declared this `DevServer`.
 */
export interface DevServer extends Resource<
  "Build.DevServer",
  DevServerProps,
  {
    /**
     * URL extracted from the first matching stdout/stderr line. Best-effort:
     * `undefined` if no URL appeared within {@link URL_EXTRACT_TIMEOUT}.
     */
    url?: string;
  }
> {}

/**
 * A long-lived shell process scoped to a stack instance, started during
 * `alchemy dev` and restarted when inputs change. During deploy this is
 * a no-op — `DevServer` resources only run in dev mode.
 *
 * The child process runs inside the dev sidecar so it survives
 * user-code HMR restarts. Its stdout/stderr are mirrored to the
 * terminal and scanned for the first `http(s)://…` URL, which is
 * exposed as the `url` output attribute.
 *
 * @resource
 *
 * @section Basic Usage
 * Pass a shell command that starts a long-lived dev server. Alchemy
 * runs it in the background and extracts the first URL it prints.
 *
 * @example Start a Vite dev server
 * ```typescript
 * const dev = yield* DevServer("Frontend", {
 *   command: "npm run dev",
 * });
 * console.log(dev.url); // e.g. "http://localhost:5173"
 * ```
 *
 * @section Working Directory
 * Use `cwd` to run the command in a subdirectory — useful in
 * monorepos where each package has its own dev server.
 *
 * @example Monorepo package
 * ```typescript
 * const dev = yield* DevServer("Web", {
 *   command: "npm run dev",
 *   cwd: "apps/web",
 * });
 * ```
 *
 * @section Environment Variables
 * Extra environment variables are merged on top of `process.env`.
 * Sensitive values can be wrapped in `Redacted` to keep them out
 * of logs and state files.
 *
 * @example Custom port and env
 * ```typescript
 * const dev = yield* DevServer("Api", {
 *   command: "npm run dev",
 *   env: {
 *     PORT: "4000",
 *     DATABASE_URL: Redacted.make("postgres://..."),
 *   },
 * });
 * ```
 */
export const DevServer = Resource<DevServer>("Build.DevServer");

/**
 * How long reconcile waits for a URL to appear in the child's output
 * before giving up and returning `{ url: undefined }`. The child keeps
 * running either way — this only bounds how long the deploy plan waits.
 *
 * Kept small because dev servers (vite, next, zola, …) print their URL
 * within ~1s, and a long wait here just stalls `alchemy dev` startup
 * for commands that never produce a URL.
 */
const URL_EXTRACT_TIMEOUT = "5 seconds";

// Matches the first plain http(s) URL. Stops at whitespace and at a small
// set of punctuation typically used to wrap URLs in log output.
const URL_REGEX = /https?:\/\/[^\s)\],"'`]+/;

// ECMA-262 ANSI/VT100 escape sequences — `Vite`, `Next`, etc. surround the
// URL with color codes that would otherwise be eaten by the URL regex.
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

/**
 * Live-mode no-op. `DevServer` resources should only be created in dev mode;
 * if one slips into a deploy, this is a noisy no-op rather than a crash.
 */
export const LiveDevServerProvider = () =>
  Provider.effect(
    DevServer,
    Effect.succeed(
      DevServer.Provider.of({
        diff: () => Effect.succeed({ action: "noop" }),
        reconcile: () => Effect.succeed({}),
        delete: () => Effect.void,
        // Non-listable: a DevServer is a local dev-server child process, not a
        // cloud resource. There is no remote enumeration API.
        list: () => Effect.succeed([]),
      }),
    ),
  );

/**
 * Dev-mode provider. Runs inside the RPC sidecar so the child process
 * outlives user-code restarts. Tracks instances in a module-level closure
 * keyed by resource id; on `reconcile`, it diffs the props hash and either
 * reuses the existing process or interrupts + respawns.
 */
export const LocalDevServerProvider = () =>
  RpcProvider.effect(
    DevServer,
    import.meta.resolve(
      // See LocalWorkerProvider — must match the on-disk extension of the
      // sidecar entry file.
      import.meta.url.endsWith(".ts") ? "./Local.ts" : "./Local.js",
      import.meta.url,
    ),
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner;
      // The provider's outer scope lives for the lifetime of the sidecar,
      // which is exactly what we want: child processes get forked into
      // sub-scopes off of this one, so they survive any single user-code
      // restart but die when the sidecar shuts down.
      const rootScope = yield* Effect.scope;

      const instances = new Map<
        string,
        {
          hash: number;
          handle: ChildProcessHandle;
          scope: Scope.Closeable;
          /**
           * Resolves with the first URL found in the child's output. Stored
           * on the instance so that no-op reconciles (same hash, process
           * still running) can await it too — even if the URL hadn't yet
           * appeared at the previous reconcile.
           */
          urlDeferred: Deferred.Deferred<string>;
        }
      >();

      const spawn = Effect.fn(function* (
        props: DevServerProps,
        urlDeferred: Deferred.Deferred<string>,
      ) {
        const [command, ...args] = props.command.split(" ");

        const handle = yield* spawner.spawn(
          ChildProcess.make(command, args, {
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
            // Leave stdout/stderr piped so we can both mirror to the parent
            // terminal AND parse lines for the first URL.
          }),
        );

        // Mirror + extract on both streams, forked into the current scope so
        // they're interrupted when the instance scope closes.
        yield* mirrorAndExtract(handle.stdout, "stdout", urlDeferred).pipe(
          Effect.forkScoped,
        );
        yield* mirrorAndExtract(handle.stderr, "stderr", urlDeferred).pipe(
          Effect.forkScoped,
        );

        return handle;
      });

      const stop = Effect.fn(function* (id: string) {
        const existing = instances.get(id);
        if (existing) {
          yield* existing.handle.kill();
          yield* Scope.close(existing.scope, Exit.void);
          instances.delete(id);
        }
      });

      const awaitUrl = (deferred: Deferred.Deferred<string>) =>
        Deferred.await(deferred).pipe(
          Effect.timeoutOption(URL_EXTRACT_TIMEOUT),
          Effect.map(Option.getOrUndefined),
        );

      return DevServer.Provider.of({
        diff: Effect.fn(function* ({ instanceId, news }) {
          if (!isResolved(news)) return undefined;
          const hash = Hash.structure(news);
          if (instances.get(instanceId)?.hash === hash) {
            return { action: "noop" };
          }
          return { action: "update" };
        }),
        reconcile: Effect.fn(function* ({ instanceId, news }) {
          const hash = Hash.structure(news);
          const existing = instances.get(instanceId);

          if (existing) {
            if (existing.hash === hash && (yield* existing.handle.isRunning)) {
              const url = yield* awaitUrl(existing.urlDeferred);
              return { url };
            }

            yield* stop(instanceId);
          }

          const scope = yield* Scope.fork(rootScope);
          const urlDeferred = yield* Deferred.make<string>();
          const handle = yield* spawn(news, urlDeferred).pipe(
            Scope.provide(scope),
          );
          instances.set(instanceId, { hash, handle, scope, urlDeferred });
          const url = yield* awaitUrl(urlDeferred);
          return { url };
        }),
        delete: Effect.fn(function* ({ instanceId }) {
          yield* stop(instanceId);
        }),
        // Non-listable: a DevServer is a local dev-server child process, not a
        // cloud resource. There is no remote enumeration API. The in-memory
        // `instances` map is sidecar-local process state, not a queryable
        // resource collection, so list() returns [].
        list: () => Effect.succeed([]),
      });
    }),
  );

/**
 * Drains a child stdout/stderr stream into the matching parent stream while
 * scanning each completed line for the first URL. Resolves `urlDeferred`
 * the first time a URL is found (subsequent calls are no-ops).
 *
 * Modeled on `idempotent-spawn.ts`'s `extract` hook — single-pass over each
 * line, ANSI escapes stripped before matching, with a buffer for incomplete
 * trailing lines across chunk boundaries.
 */
const mirrorAndExtract = (
  source: Stream.Stream<Uint8Array, any>,
  sink: "stdout" | "stderr",
  urlDeferred: Deferred.Deferred<string>,
) =>
  Effect.gen(function* () {
    let lineBuffer = "";
    const decoder = new TextDecoder("utf-8");
    yield* Stream.runForEach(source, (chunk) =>
      Effect.sync(() => {
        // Pass the raw bytes through so terminal colors, cursor moves,
        // progress bars etc. keep working.
        process[sink].write(chunk);

        lineBuffer += decoder.decode(chunk, { stream: true });
        let newlineIdx = lineBuffer.indexOf("\n");
        while (newlineIdx !== -1) {
          const line = lineBuffer.slice(0, newlineIdx);
          lineBuffer = lineBuffer.slice(newlineIdx + 1);
          newlineIdx = lineBuffer.indexOf("\n");
          const match = line.replace(ANSI_REGEX, "").match(URL_REGEX);
          if (match) {
            // Deferred.doneUnsafe is a synchronous fire-and-forget — first
            // caller wins, subsequent calls are dropped, which is exactly
            // what we want for "record the FIRST URL".
            Deferred.doneUnsafe(urlDeferred, Effect.succeed(match[0]));
            return;
          }
        }
      }),
    );
  });

/**
 * Selects the live or dev DevServer provider based on `AlchemyContext.dev`.
 */
export const DevServerProvider = () =>
  Layer.unwrap(
    AlchemyContext.useSync((context) =>
      context.dev ? LocalDevServerProvider() : LiveDevServerProvider(),
    ),
  );
