import { isResolved } from "alchemy/Diff";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ref from "effect/Ref";
import { acquire, type Acquired } from "./internal/Acquire.ts";
import * as Mode from "./internal/Mode.ts";
import * as State from "./internal/State.ts";

export interface ProxyProps {
  /**
   * The namespace between a service's name and `.localhost`. Stage `dev-alice`,
   * service `Api` and domain `myapp` give `https://dev-alice.api.myapp.localhost`.
   * Lowercase letters, digits, hyphens and dots.
   */
  domain: string;
}

export interface ProxyAttributes {
  /** The domain the proxy's services are named under. */
  domain: string;
  /**
   * The port the proxy listens on: `PORTLESS_PORT`, or 443. Origins leave it
   * out when it is 443.
   */
  port: number;
  /**
   * The directory the proxy keeps its routes, certificates and markers in:
   * `PORTLESS_STATE_DIR`, or `~/.portless`.
   */
  stateDirectory: string;
  /**
   * Absolute path of the CA certificate that signs the proxy's certificates.
   * Point `NODE_EXTRA_CA_CERTS` or a client's `ca` option at it to trust the
   * proxy without installing anything.
   */
  certificateAuthority: string;
}

export interface Proxy extends Resource<"Portless.Proxy", ProxyProps, ProxyAttributes> {}

/**
 * The shared [Portless](https://github.com/vercel-labs/portless) proxy that
 * gives local services stable HTTPS names. One proxy serves every stage,
 * stack and worktree on the machine: `alchemy dev` starts it when it isn't
 * running, reuses it when it is, and never stops it.
 *
 * It listens on port 443 as an unprivileged process (`--unprivileged`), so it
 * never asks for sudo and never runs a root daemon. On macOS that works as it
 * is; on Linux, `net.ipv4.ip_unprivileged_port_start` must allow port 443, and
 * the error says the exact `sysctl` command when it doesn't. The proxy is
 * acquired while the providers build, before other local providers start, so
 * it holds port 443 before an emulator can publish it.
 *
 * The first run asks the operating system once to trust the proxy's CA
 * (`portless trust`: a Keychain prompt on macOS, sudo on Linux); a second run,
 * stage or worktree finds it trusted and prompts for nothing. On Linux the CA
 * is also added to Chromium's NSS database, which needs `certutil`.
 *
 * A proxy that is already running is reused when it serves HTTPS on the same
 * port, `.localhost` only, outside LAN mode and with Portless's own CA, however
 * it was started: one that wasn't started with `--unprivileged` serves the same
 * routes. Otherwise the run fails and says what differs; Alchemy never restarts
 * a shared proxy for you. A run with `PORTLESS=0` skips the proxy altogether.
 *
 * A plain `alchemy deploy` never starts a proxy: the resource is a no-op
 * outside `alchemy dev`.
 *
 * ### Starting the proxy
 * **Example:** A proxy for the `myapp` namespace
 * ```typescript
 * const proxy = yield* Portless.Proxy("Proxy", {
 *   domain: "myapp",
 * });
 * ```
 *
 * ### Moving the proxy
 * Portless's own settings move it, so there is no prop for either. Use them to
 * keep a stack away from the proxy another project runs.
 *
 * **Example:** A private proxy on port 8443
 * ```sh
 * PORTLESS_STATE_DIR=.portless PORTLESS_PORT=8443 alchemy dev
 * ```
 *
 * ### Trusting the proxy from Node
 * Browsers trust the CA after the first run. Node does not read the system
 * store, but during `alchemy dev` local Workers and the commands `Command.Dev`
 * and `Portless.Dev` start trust the CA with no setup. A process you start
 * another way needs the CA's path.
 *
 * **Example:** Point a client started outside Alchemy at the CA
 * ```sh
 * NODE_EXTRA_CA_CERTS=~/.portless/ca.pem node client.js
 * ```
 *
 * @resource
 */
export const Proxy = Resource<Proxy>("Portless.Proxy");

/** What `alchemy deploy` and `PORTLESS=0` see: a proxy that isn't there. */
const unmanaged = (domain: string): ProxyAttributes => ({
  domain,
  port: State.DEFAULT_PORT,
  stateDirectory: "",
  certificateAuthority: "",
});

export const ProxyProvider = () =>
  ProviderLayer.dual(Proxy, {
    live: ProxyProviderLive,
    local: ProxyProviderLocal,
  });

export const ProxyProviderLive = () =>
  Provider.succeed(Proxy, {
    list: () => Effect.succeed([]),
    diff: () => Effect.succeed({ action: "noop" }),
    reconcile: ({ news }) => Effect.succeed(unmanaged(news.domain)),
    delete: () => Effect.void,
  });

/**
 * Acquires the machine's shared proxy while the provider builds, before any
 * resource is evaluated. A failed first attempt is not fatal here: the
 * resource's own reconcile tries again and reports the failure on the resource.
 */
export const ProxyProviderLocal = () =>
  Layer.unwrap(
    Effect.gen(function* () {
      const services = yield* Effect.context<
        FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
      >();
      const disabled = yield* Mode.disabled;
      const settings = yield* State.settings;
      const attempt = acquire(settings).pipe(Effect.provideContext(services));
      const acquired = yield* Ref.make<Acquired | undefined>(undefined);
      if (!disabled) {
        const first = yield* Effect.exit(attempt);
        if (Exit.isSuccess(first)) yield* Ref.set(acquired, first.value);
      }

      return Provider.succeed(Proxy, {
        list: () => Effect.succeed([]),
        // Unchanged only while the state recorded for the stage is the proxy in hand;
        // anything else, a first run or a proxy that moved, publishes it again. A
        // settled proxy keeps every service that depends on it settled too.
        diff: Effect.fn(function* ({ news, output }) {
          if (disabled || !isResolved(news)) return undefined;
          const current = yield* Ref.get(acquired);
          return current !== undefined &&
            output?.domain === news.domain &&
            output.port === current.port &&
            output.stateDirectory === current.stateDirectory &&
            output.certificateAuthority === current.certificateAuthority
            ? ({ action: "noop" } as const)
            : ({ action: "update" } as const);
        }),
        reconcile: Effect.fn(function* ({ news }) {
          if (disabled) return unmanaged(news.domain);
          const current = yield* Ref.get(acquired);
          const proxy = current ?? (yield* attempt);
          yield* Ref.set(acquired, proxy);
          return { domain: news.domain, ...proxy };
        }),
        // The proxy outlives every session and belongs to the machine.
        delete: () => Effect.void,
      });
    }),
  );
