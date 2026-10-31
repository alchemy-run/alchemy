import * as NodeHttps from "node:https";
import * as Portless from "@alchemy.run/portless";
import * as Cli from "@alchemy.run/portless/internal/Cli";
import { run } from "@alchemy.run/portless/internal/Run";
import * as Trust from "@alchemy.run/portless/internal/Trust";
import * as DevTrust from "alchemy/Local/DevTrust";
import { findAvailablePort } from "alchemy/Util/Node";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import { eventually } from "./Processes.ts";

/**
 * A proxy of the test's own: a temporary state directory and a free high port,
 * so a test never reaches the proxy already running on this machine, and
 * nothing is trusted, so a test never prompts. The directory and the port are
 * made once per test file and shared by every provider build in it.
 * `extraConfig` adds settings, such as `PORTLESS: "0"`, to what the providers read.
 */
export interface TestProxy {
  readonly stateDirectory: Effect.Effect<string>;
  readonly port: Effect.Effect<number>;
  /** The settings the providers read, for a stack program that reads them too (`Portless.Origin`). */
  readonly config: Layer.Layer<never>;
  /** The Portless providers, pointed at this proxy and with the trust step swapped out. */
  readonly providers: () => ReturnType<typeof Portless.providers>;
  /** Stops the proxy this test started and removes its state directory. */
  readonly stop: Effect.Effect<void>;
}

// `DevTrust.publish` sets ALCHEMY_DEV_TRUST on the test process, which every file shares and
// the shared sidecar inherits when it starts. Only a file that needs its proxy's CA trusted
// publishes it, with a sidecar of its own; the variable goes back when its proxy stops.
let trustBefore: { readonly value: string | undefined } | undefined;
let trustProxies = 0;

export interface TestProxyOptions {
  /** Publish the proxy's CA as `alchemy dev` does, for local runtimes and commands to trust. */
  readonly trust?: boolean;
}

export const make = (
  extraConfig: Record<string, string> = {},
  options: TestProxyOptions = {},
): TestProxy => {
  let created: Promise<{ stateDirectory: string; port: number }> | undefined;
  const entry = Effect.promise(
    () =>
      (created ??= Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const stateDirectory = yield* fs.makeTempDirectory({ prefix: "alchemy-portless-test-" });
          const port = yield* findAvailablePort();
          return { stateDirectory, port };
        }).pipe(Effect.provide(PlatformServices)),
      )),
  );

  // What `PORTLESS_STATE_DIR=<dir> alchemy dev` does at startup: the CAs it trusts are published
  // for the local runtimes and commands it starts, and the Portless CA is the one in that
  // directory. The settings reach the contribution the way they reach the providers.
  let published: Promise<void> | undefined;
  const publishTrust = (settings: ConfigProvider.ConfigProvider) =>
    options.trust !== true
      ? Effect.void
      : Effect.promise(
          () =>
            (published ??= Effect.runPromise(
              Effect.gen(function* () {
                trustBefore ??= { value: process.env.ALCHEMY_DEV_TRUST };
                trustProxies += 1;
                yield* DevTrust.publish();
              }).pipe(
                Effect.provideService(ConfigProvider.ConfigProvider, settings),
                Effect.provide(PlatformServices),
              ),
            )),
        );

  const config = Layer.effect(ConfigProvider.ConfigProvider)(
    Effect.gen(function* () {
      const current = yield* ConfigProvider.ConfigProvider;
      const { stateDirectory, port } = yield* entry;
      const settings = ConfigProvider.orElse(
        ConfigProvider.fromUnknown({
          ...extraConfig,
          PORTLESS_STATE_DIR: stateDirectory,
          PORTLESS_PORT: String(port),
        }),
        current,
      );
      yield* publishTrust(settings);
      return settings;
    }),
  );

  return {
    config,
    stateDirectory: Effect.map(entry, (value) => value.stateDirectory),
    port: Effect.map(entry, (value) => value.port),
    providers: () =>
      Portless.providers().pipe(Layer.provide(config), Layer.provide(Trust.layer(Trust.TrustNone))),
    stop: Effect.gen(function* () {
      if (created === undefined) return;
      const { stateDirectory, port } = yield* Effect.promise(() => created!);
      const fs = yield* FileSystem.FileSystem;
      yield* stopPortless(stateDirectory, port);
      yield* fs.remove(stateDirectory, { recursive: true, force: true });
      if (published !== undefined) trustProxies -= 1;
      if (trustProxies === 0 && trustBefore !== undefined) {
        if (trustBefore.value === undefined) delete process.env.ALCHEMY_DEV_TRUST;
        else process.env.ALCHEMY_DEV_TRUST = trustBefore.value;
        trustBefore = undefined;
      }
    }).pipe(Effect.provide(PlatformServices), Effect.ignore),
  };
};

/**
 * Starts a Portless proxy the way a person or another tool would, with the
 * given flags, in a state directory and on a port of the test's choosing. The
 * environment is pinned so it never trusts anything and never needs sudo.
 */
export const startPortless = (stateDirectory: string, port: number, flags: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const node = yield* Cli.node;
    const cli = yield* Cli.portless;
    const result = yield* run(
      ChildProcess.make(
        node,
        [cli, "proxy", "start", ...flags, "--port", String(port), "--skip-trust"],
        {
          env: {
            PORTLESS_STATE_DIR: stateDirectory,
            PORTLESS_PORT: String(port),
            // A proxy that isn't unprivileged would otherwise try to edit the hosts file.
            PORTLESS_SYNC_HOSTS: "0",
          },
          extendEnv: true,
          stdin: "ignore",
        },
      ),
    );
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        new Error(`portless proxy start failed: ${result.stdout}${result.stderr}`),
      );
    }
  });

/** Stops the proxy a state directory records. */
export const stopPortless = (stateDirectory: string, port: number) =>
  Effect.gen(function* () {
    const node = yield* Cli.node;
    const cli = yield* Cli.portless;
    yield* run(
      ChildProcess.make(node, [cli, "proxy", "stop"], {
        env: { PORTLESS_STATE_DIR: stateDirectory, PORTLESS_PORT: String(port) },
        extendEnv: true,
        stdin: "ignore",
      }),
    );
  });

export interface Response {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string | ReadonlyArray<string> | undefined>;
}

/**
 * GETs a route over real HTTPS, trusting only the proxy's own CA. The request
 * goes to the proxy on 127.0.0.1 and names the host in SNI and `Host`, so it
 * doesn't depend on how this machine resolves `.localhost`.
 */
export const get = (
  origin: string,
  proxy: { readonly port: number; readonly certificateAuthority: string },
  path = "/",
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const ca = yield* fs.readFileString(proxy.certificateAuthority);
    const url = new URL(origin);
    return yield* Effect.callback<Response, Error>((resume) => {
      const request = NodeHttps.request(
        {
          host: "127.0.0.1",
          port: proxy.port,
          path,
          method: "GET",
          servername: url.hostname,
          // No kept-alive socket: it would hold the proxy up when it is told to stop.
          agent: false,
          headers: { host: url.host, connection: "close" },
          ca,
          timeout: 10_000,
        },
        (response) => {
          const chunks: Array<Buffer> = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resume(
              Effect.succeed({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
                headers: response.headers,
              }),
            ),
          );
        },
      );
      request.once("error", (error) => resume(Effect.fail(error)));
      request.once("timeout", () => request.destroy(new Error(`GET ${origin}${path} timed out`)));
      request.end();
      return Effect.sync(() => request.destroy());
    });
  });

const unreachable: Response = { status: 0, body: "", headers: {} };

/** GETs until the route answers with the status: the proxy needs a moment to see a route change. */
export const answers = (
  origin: string,
  proxy: { readonly port: number; readonly certificateAuthority: string },
  status: number,
  path = "/",
) =>
  eventually(
    get(origin, proxy, path).pipe(Effect.orElseSucceed(() => unreachable)),
    (response) => response.status === status,
    `${origin}${path} answering ${status}`,
  );

/** GETs until the route answers 200. */
export const serving = (
  origin: string,
  proxy: { readonly port: number; readonly certificateAuthority: string },
  path = "/",
) => answers(origin, proxy, 200, path);
