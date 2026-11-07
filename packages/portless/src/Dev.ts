import { CommandError, CommandExecutor, UnexpectedExit } from "alchemy/Command/Command";
import { makeCommandRedactor } from "alchemy/Command/Redaction";
import * as LocalProvider from "alchemy/Local/LocalProvider";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { Stage } from "alchemy/Stage";
import { findAvailablePort, moduleExtension } from "alchemy/Util/Node";
import { makeResourceOutput } from "alchemy/Util/ResourceOutput";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { DevPortInUse, DevPortUnavailable } from "./Errors.ts";
import * as Claims from "./internal/Claims.ts";
import * as Host from "./internal/Host.ts";
import { hostnameOf, originOf, routedName } from "./internal/Hostname.ts";
import { processStartTime } from "./internal/Identity.ts";
import * as Mode from "./internal/Mode.ts";
import { isListening } from "./internal/Probe.ts";
import * as Routes from "./internal/Routes.ts";
import type { ProxyAttributes } from "./Proxy.ts";

export interface DevProps {
  /** The proxy that routes to this command. */
  proxy: ProxyAttributes;
  /**
   * The command that starts the dev server, run in a shell so `$PORT` and
   * `$HOST` expand. The server must listen on `$PORT`: pass it on to tools
   * that ignore the variable (`vite --port $PORT --strictPort`).
   */
  command: string;
  /**
   * The port the command listens on. When set, it is the port that stays the
   * same across restarts, and the resource fails rather than shift to another
   * if something already listens there. When omitted, the operating system
   * assigns a free port on every start.
   *
   * With `PORTLESS=0` there is no proxy, so this is also the port the origin
   * names: `http://localhost:<port>`.
   *
   * @default a free port the operating system assigns on every start
   */
  port?: number;
  /**
   * The directory the command runs in.
   * @default the process's working directory
   */
  cwd?: string;
  /**
   * Environment variables for the command, on top of this process's and of the
   * ones Portless sets: `PORT`, `HOST`, `PORTLESS_URL` and `PORTLESS_STATE_DIR`,
   * which win over yours. During `alchemy dev` it also gets a
   * `NODE_EXTRA_CA_CERTS` bundle of every CA `alchemy dev` trusts, the Portless
   * CA among them; yours replaces it.
   */
  env?: Record<string, string | Redacted.Redacted<string> | undefined>;
}

export interface Dev extends Resource<
  "Portless.Dev",
  DevProps,
  {
    /**
     * The name the proxy serves the command under, such as
     * `dev-alice.api.myapp.localhost`: `<stage>.<id>.<domain>.localhost`.
     */
    hostname: string;
    /**
     * Where to reach the command, such as `https://dev-alice.api.myapp.localhost`.
     * With `PORTLESS=0` it is `http://localhost:<port>`.
     */
    origin: string;
    /** The port the command listens on behind the proxy. */
    port: number;
  }
> {}

/**
 * A long-running dev command, such as a server, served behind the Portless
 * proxy under a stable HTTPS name. It starts during `alchemy dev` and
 * restarts when its inputs change; during `alchemy deploy` it does nothing.
 *
 * The command runs inside the dev sidecar, as `Command.Dev` does, so an
 * edit that reloads your stack program leaves the server running and its
 * route in place. The command listens on `$PORT`; its environment also holds
 * `HOST` (`127.0.0.1`), `PORTLESS_URL` (its public origin), `PORTLESS_STATE_DIR`
 * and a `NODE_EXTRA_CA_CERTS` bundle that trusts the Portless CA together with
 * the CA your shell already names and any other CA `alchemy dev` trusts.
 *
 * The route lives as long as the command: it goes when the command exits (the
 * next plan then shows an update and starts it again), when it restarts and
 * when the resource is deleted. A hostname another resource already routes is
 * rejected, not taken over.
 *
 * ### Serving a command
 * **Example:** A server that listens on `$PORT`
 * ```typescript
 * const api = yield* Portless.Dev("Api", {
 *   proxy,
 *   command: "node --watch server.ts",
 * });
 * api.origin; // "https://dev-alice.api.myapp.localhost"
 * ```
 *
 * ### Passing one service's origin to another
 * **Example:** A web app that calls the API
 * ```typescript
 * const web = yield* Portless.Dev("Web", {
 *   proxy,
 *   command: "vite --port $PORT --strictPort",
 *   env: { API_URL: api.origin },
 * });
 * ```
 *
 * ### Using a fixed port
 * **Example:** A port that stays the same across restarts
 * ```typescript
 * const web = yield* Portless.Dev("Web", {
 *   proxy,
 *   port: 5173,
 *   command: "vite --port $PORT --strictPort",
 * });
 * ```
 *
 * @resource
 */
export const Dev = Resource<Dev>("Portless.Dev");

export const DevProvider = () =>
  ProviderLayer.dual(Dev, {
    live: DevProviderLive,
    local: DevProviderLocal,
  });

export const DevProviderLive = () =>
  Provider.succeed(Dev, {
    list: () => Effect.succeed([]),
    diff: () => Effect.succeed({ action: "noop" }),
    reconcile: () => Effect.succeed({ hostname: "", origin: "", port: 0 }),
    delete: () => Effect.void,
  });

/** How much of a command's stderr an error about it keeps. */
const STDERR_TAIL = 4_096;

/**
 * Claims a hostname and routes it to a port, for as long as the enclosing
 * scope lives. Returns the release, which is safe to run more than once: it
 * removes the route only while this claim still holds the hostname, so a
 * restart that already claimed it again keeps the route it registered.
 */
const holdRoute = Effect.fn(function* (input: {
  readonly hostname: string;
  readonly port: number;
  readonly stateDirectory: string;
  readonly instanceId: string;
  readonly fqn: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const held = yield* Claims.claim(input.hostname, input);
  const release = held.release.pipe(
    Effect.flatMap((mine) =>
      mine
        ? Routes.removeRoute({
            stateDirectory: input.stateDirectory,
            hostname: input.hostname,
            ownerPid: Host.pid,
          }).pipe(Effect.ignore, Effect.provideService(FileSystem.FileSystem, fs))
        : Effect.void,
    ),
  );
  yield* Effect.addFinalizer(() => release);
  yield* Routes.addRoute({
    stateDirectory: input.stateDirectory,
    hostname: input.hostname,
    port: input.port,
    ownerPid: Host.pid,
  }).pipe(Effect.onError(() => release));
  return release;
});

export const DevProviderLocal = () =>
  LocalProvider.make(
    Dev,
    import.meta.resolve(`./Local${moduleExtension(import.meta.url)}`, import.meta.url),
    Effect.gen(function* () {
      const { spawn } = yield* CommandExecutor;
      const stage = yield* Stage;

      return {
        // The command runs in the instance scope the helper provides: it keeps
        // running after `start` returns, and the scope kills it, and removes its
        // route, on restart or delete.
        start: Effect.fn(function* ({ id, fqn, instanceId, news, invalidate }) {
          const disabled = yield* Mode.disabled;
          const { command, cwd, proxy } = news;

          const port =
            news.port ??
            (yield* findAvailablePort().pipe(
              Effect.mapError((cause) => new DevPortUnavailable({ cause })),
            ));
          // A restart has already killed the previous command, so a listener on a port
          // the caller chose is someone else's, and readiness would mistake it for ours.
          if (news.port !== undefined && (yield* isListening(port))) {
            return yield* new DevPortInUse({ port, command });
          }

          const hostname = yield* hostnameOf(routedName(id, stage, proxy.domain));
          const origin = disabled ? Mode.localOrigin(port) : originOf(hostname, proxy.port);
          // Registered before the command starts, so the proxy answers 502 while it boots.
          const release = disabled
            ? Effect.void
            : yield* holdRoute({
                hostname,
                port,
                stateDirectory: proxy.stateDirectory,
                instanceId,
                fqn,
              });

          // `spawn` adds the bundle of the CAs `alchemy dev` trusts, the Portless CA among
          // them (see Contributions.ts), under whatever `news.env` sets.
          const env = {
            ...news.env,
            PORT: `${port}`,
            HOST: "127.0.0.1",
            PORTLESS_URL: origin,
            ...(disabled ? {} : { PORTLESS_STATE_DIR: proxy.stateDirectory }),
          };
          const child = yield* spawn({ command, cwd, shell: true, env });
          const redactor = makeCommandRedactor(env);

          if (!disabled) {
            // Where Portless finds the command's process group again, in its own encoding.
            // Without it Portless can't stop a command a dead session left behind, which
            // is no reason to fail this one.
            yield* Routes.updateRoute({
              stateDirectory: proxy.stateDirectory,
              hostname,
              childPgid: child.pid,
              childStartTime: yield* processStartTime(child.pid),
            }).pipe(
              Effect.tapError((error) => Effect.logWarning(error.message)),
              Effect.ignore,
            );
          }

          // Through the logger, never a raw fd write: the process that owns the
          // terminal renders the records.
          const output = yield* makeResourceOutput(fqn);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              output.stdout.flush();
              output.stderr.flush();
            }),
          );
          let stderrTail = "";
          const mirror = (sink: "stdout" | "stderr") =>
            child[sink].pipe(
              Stream.decodeText,
              redactor.stream,
              Stream.tap((text) =>
                Effect.sync(() => {
                  output[sink].push(text);
                  if (sink === "stderr") stderrTail = (stderrTail + text).slice(-STDERR_TAIL);
                }),
              ),
              Stream.runDrain,
              Effect.forkScoped,
            );
          yield* mirror("stdout");
          yield* mirror("stderr");

          // Ready once the port accepts a connection, however long that takes;
          // failed if the command exits first.
          yield* Effect.raceAllFirst([
            isListening(port).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("100 millis"),
                until: (listening) => listening,
              }),
            ),
            child.exitCode.pipe(
              Effect.mapError(
                (error) =>
                  new CommandError({ command: redactor.redact(command), reason: error.reason }),
              ),
              Effect.flatMap((exitCode) =>
                Effect.fail(
                  new CommandError({
                    command: redactor.redact(command),
                    reason: new UnexpectedExit({ exitCode, stderr: redactor.redact(stderrTail) }),
                  }),
                ),
              ),
            ),
          ]);

          // The command may die on its own after readiness. Its route goes with it,
          // and dropping it from the registry makes the next plan report `update`
          // and start it again.
          yield* child.exitCode.pipe(
            Effect.exit,
            Effect.andThen(release),
            Effect.andThen(invalidate),
            Effect.forkScoped,
          );

          return { hostname, origin, port };
        }),
      };
    }),
  );
