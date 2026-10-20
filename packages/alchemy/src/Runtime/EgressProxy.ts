import * as net from "node:net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { type LocalCa, makeLocalCa } from "../Egress/LocalCa.ts";
import {
  DEFAULT_CONTROL_PORT,
  DEFAULT_PROXY_PORT,
  type EgressProxy,
  EgressProxyError,
  serveEgressControl,
  serveEgressProxy,
} from "../Egress/Proxy.ts";
import { type Route, Routes } from "../Egress/Route.ts";
import { trustEnv, writeTrustBundle } from "../Egress/Trust.ts";
/**
 * Start the in-sandbox egress proxy (Egress/Proxy.ts) before the program
 * when the image was built with egress support (`ALCHEMY_EGRESS_PROXY`).
 * The first route table arrives in `ALCHEMY_EGRESS_ROUTES`; the owner
 * replaces it at run time through the control endpoint, authenticated with
 * `ALCHEMY_EGRESS_CONTROL_SECRET`.
 *
 * On an AWS Lambda MicroVM (`ALCHEMY_EGRESS_RUN_HOOK`) the process is
 * snapshotted at build time, so nothing per-run can be in its env: the
 * secret, the first table and the program's env arrive in the `/run`
 * lifecycle hook, which the control endpoint answers — and so is the
 * proxy's CA, minted there so no two MicroVMs of one image share it (see
 * {@link serveSandboxEgress}).
 *
 * Everything the program starts (git, gh, a harness CLI) inherits
 * `HTTPS_PROXY` and a CA bundle that trusts the proxy's per-sandbox CA.
 */
import { serveExec } from "./ExecServer.ts";

/** Set at deploy time on images that run the proxy. */
export const EGRESS_PROXY_SWITCH = "ALCHEMY_EGRESS_PROXY";
/** The proxy's CA alone. */
export const EGRESS_PROXY_CA = "/tmp/alchemy-egress-proxy-ca.pem";
/** System roots plus the proxy's CA. */
export const EGRESS_PROXY_CA_BUNDLE = "/tmp/alchemy-egress-proxy-ca-bundle.pem";

const decodeRoutes = Schema.decodeUnknownEffect(Schema.fromJsonString(Routes));

/**
 * Set at deploy time on AWS Lambda MicroVM sandbox images: the per-run
 * configuration arrives in the `/run` lifecycle hook (see {@link RunPayload}).
 */
export const EGRESS_RUN_HOOK_SWITCH = "ALCHEMY_EGRESS_RUN_HOOK";

/** What the owner passes as `runHookPayload` when it runs a MicroVM sandbox. */
export const RunPayload = Schema.Struct({
  /** Authenticates `PUT /routes` from now on. */
  secret: Schema.String,
  /** The first route table (absent: pushed once the MicroVM runs). */
  routes: Schema.optional(Routes),
  /** Environment for programs started from now on (placeholders, `start({ env })`). */
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** `start({ enableInternet })`: whether hosts without a route are reachable. */
  internet: Schema.optional(Schema.Boolean),
});
export type RunPayload = typeof RunPayload.Type;

const decodeRunPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(RunPayload));

/** Whether the program's HTTP server (`PORT`) accepts connections: the image is ready to snapshot. */
const programListening = Effect.callback<boolean>((resume) => {
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port <= 0) return resume(Effect.succeed(true));
  const socket = net.connect(port, "127.0.0.1");
  let settled = false;
  const done = (ok: boolean) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resume(Effect.succeed(ok));
  };
  socket.once("connect", () => done(true));
  socket.once("error", () => done(false));
  socket.setTimeout(2_000, () => done(false));
});

const portFromEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
};

export interface SandboxEgressOptions {
  /** Where the proxy listens (0 picks a free port). */
  readonly proxyPort: number;
  /** Where the control endpoint (and the MicroVM lifecycle hooks) listen. */
  readonly controlPort: number;
  /** @default "0.0.0.0" (the owner pushes from outside the sandbox) */
  readonly controlHost?: string;
  /** The proxy's CA alone. */
  readonly caPath: string;
  /** System roots plus the proxy's CA: what {@link trustEnv} points at. */
  readonly bundlePath: string;
  /** The first route table (ignored with `runHook`: it arrives in `/run`). */
  readonly routes: ReadonlyArray<Route>;
  /** Authenticates `PUT /routes` (ignored with `runHook`: it arrives in `/run`). */
  readonly secret?: string;
  /**
   * An AWS Lambda MicroVM: this process is snapshotted at build time, so the
   * control secret, the first route table, the program's env AND the CA
   * arrive (or are minted) in the `/run` hook.
   */
  readonly runHook?: boolean;
  /** `ready` hook: whether the image is ready to snapshot. */
  readonly ready?: Effect.Effect<boolean>;
}

const writeCa = (options: SandboxEgressOptions, ca: LocalCa) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(options.caPath, ca.pem);
    yield* writeTrustBundle(options.bundlePath, [ca.pem]);
  }).pipe(
    Effect.mapError(
      (cause) => new EgressProxyError({ message: "failed to write the egress CA bundle", cause }),
    ),
  );

const mintCa = makeLocalCa.pipe(
  Effect.mapError((cause) => new EgressProxyError({ message: cause.message, cause })),
);

/**
 * Serve the proxy and its control endpoint, and write the CA and trust
 * bundle, until the scope closes.
 *
 * Outside a MicroVM the CA is minted now. In a MicroVM (`runHook`) anything
 * minted now would be in the build-time snapshot, shared by every MicroVM of
 * the image, so the proxy starts with no CA (it decrypts nothing and routes
 * nothing) and the bundle holds the system roots alone. The `/run` hook then
 * mints this MicroVM's own CA, rewrites the bundle in place (the paths in
 * {@link trustEnv} stay valid), installs the CA in the proxy, and only then
 * applies the first route table.
 *
 * Who trusts the new CA: the bundle is read by each program at its own
 * start. The program itself (this process) starts before `/run`, but it
 * never trusted the bundle: `NODE_EXTRA_CA_CERTS` is read once at process
 * start and is only set below, after start. The tools that need it (git,
 * gh, a harness CLI) are children the program spawns per request, after
 * `/run` (the placeholder credentials they use only arrive there), so they
 * read the new bundle. A child spawned before `/run` would trust only the
 * system roots: it fails closed on a routed host rather than trusting a
 * snapshot-shared CA.
 */
export const serveSandboxEgress = (
  options: SandboxEgressOptions,
): Effect.Effect<
  { readonly proxy: EgressProxy; readonly controlPort?: number },
  EgressProxyError,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const controlHost = options.controlHost ?? "0.0.0.0";
    const fs = yield* FileSystem.FileSystem;
    if (options.runHook) {
      // No routes until `/run`: nothing is decrypted before this MicroVM has its own CA.
      const routes = yield* SubscriptionRef.make<ReadonlyArray<Route>>([]);
      yield* Effect.gen(function* () {
        yield* fs.remove(options.caPath, { force: true });
        yield* writeTrustBundle(options.bundlePath, []);
      }).pipe(
        Effect.mapError(
          (cause) => new EgressProxyError({ message: "failed to write the trust bundle", cause }),
        ),
      );
      const proxy = yield* serveEgressProxy({ port: options.proxyPort, routes });
      const control = yield* serveEgressControl({
        exec: serveExec,
        host: controlHost,
        port: options.controlPort,
        routes,
        hooks: {
          ready: options.ready,
          run: (payload) =>
            Effect.gen(function* () {
              const config = yield* decodeRunPayload(payload ?? "{}").pipe(
                Effect.mapError(
                  (cause) => new EgressProxyError({ message: "invalid run hook payload", cause }),
                ),
              );
              // This MicroVM's own CA, before any route exists.
              const ca = yield* mintCa;
              yield* writeCa(options, ca).pipe(Effect.provideService(FileSystem.FileSystem, fs));
              yield* proxy.useCa(ca);
              if (config.internet !== undefined) yield* proxy.useInternet(config.internet);
              if (config.routes) yield* SubscriptionRef.set(routes, config.routes);
              // Read by each program at its own start (git, gh, a harness CLI).
              if (config.env) yield* Effect.sync(() => Object.assign(process.env, config.env));
              return Redacted.make(config.secret);
            }),
        },
      });
      return { proxy, controlPort: control.port };
    }

    const routes = yield* SubscriptionRef.make(options.routes);
    const ca = yield* mintCa;
    yield* writeCa(options, ca);
    const proxy = yield* serveEgressProxy({
      port: options.proxyPort,
      routes,
      ca,
      // ALCHEMY_EGRESS_INTERNET=0: only the egress gateways are reachable.
      internet: yield* Effect.sync(() => process.env.ALCHEMY_EGRESS_INTERNET !== "0"),
    });
    if (!options.secret) {
      yield* Effect.logWarning(
        "ALCHEMY_EGRESS_CONTROL_SECRET is not set: the egress route table cannot be updated",
      );
      return { proxy };
    }
    const control = yield* serveEgressControl({
      exec: serveExec,
      host: controlHost,
      port: options.controlPort,
      routes,
      secret: Redacted.make(options.secret),
    });
    return { proxy, controlPort: control.port };
  });

export const startEgressProxy: Effect.Effect<
  void,
  EgressProxyError,
  FileSystem.FileSystem | Scope.Scope
> = Effect.gen(function* () {
  if (!process.env[EGRESS_PROXY_SWITCH]) return;

  const runHook = !!process.env[EGRESS_RUN_HOOK_SWITCH];
  const initial = runHook
    ? []
    : yield* decodeRoutes(process.env.ALCHEMY_EGRESS_ROUTES ?? "[]").pipe(
        Effect.mapError(
          (cause) => new EgressProxyError({ message: "invalid ALCHEMY_EGRESS_ROUTES", cause }),
        ),
      );
  const { proxy } = yield* serveSandboxEgress({
    proxyPort: portFromEnv("ALCHEMY_EGRESS_PROXY_PORT", DEFAULT_PROXY_PORT),
    controlPort: portFromEnv("ALCHEMY_EGRESS_CONTROL_PORT", DEFAULT_CONTROL_PORT),
    caPath: EGRESS_PROXY_CA,
    bundlePath: EGRESS_PROXY_CA_BUNDLE,
    routes: initial,
    secret: process.env.ALCHEMY_EGRESS_CONTROL_SECRET,
    runHook,
    ready: programListening,
  });

  // Read by each program at its own start. curl reads only the lowercase
  // `http_proxy`; most other tools read either case.
  yield* Effect.sync(() =>
    Object.assign(process.env, {
      HTTPS_PROXY: proxy.url,
      https_proxy: proxy.url,
      HTTP_PROXY: proxy.url,
      http_proxy: proxy.url,
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
      ...trustEnv(EGRESS_PROXY_CA_BUNDLE),
    }),
  );
});
