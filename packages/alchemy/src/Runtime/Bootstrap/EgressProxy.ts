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
 * lifecycle hook, which the control endpoint answers.
 *
 * Everything the program starts (git, gh, a harness CLI) inherits
 * `HTTPS_PROXY` and a CA bundle that trusts the proxy's per-sandbox CA.
 */
import * as net from "node:net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { makeLocalCa } from "../../Egress/LocalCa.ts";
import {
  DEFAULT_CONTROL_PORT,
  DEFAULT_PROXY_PORT,
  EgressProxyError,
  serveEgressControl,
  serveEgressProxy,
} from "../../Egress/Proxy.ts";
import { Routes } from "../../Egress/Route.ts";
import { trustEnv, writeTrustBundle } from "../../Egress/Trust.ts";

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

export const startEgressProxy: Effect.Effect<
  void,
  EgressProxyError,
  FileSystem.FileSystem | Scope.Scope
> = Effect.gen(function* () {
  if (!process.env[EGRESS_PROXY_SWITCH]) return;

  const initial = yield* decodeRoutes(process.env.ALCHEMY_EGRESS_ROUTES ?? "[]").pipe(
    Effect.mapError(
      (cause) => new EgressProxyError({ message: "invalid ALCHEMY_EGRESS_ROUTES", cause }),
    ),
  );
  const routes = yield* SubscriptionRef.make(initial);
  const ca = yield* makeLocalCa.pipe(
    Effect.mapError((cause) => new EgressProxyError({ message: cause.message, cause })),
  );

  yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(EGRESS_PROXY_CA, ca.pem);
    yield* writeTrustBundle(EGRESS_PROXY_CA_BUNDLE, [ca.pem]);
  }).pipe(
    Effect.mapError(
      (cause) => new EgressProxyError({ message: "failed to write the egress CA bundle", cause }),
    ),
  );

  const proxy = yield* serveEgressProxy({
    port: portFromEnv("ALCHEMY_EGRESS_PROXY_PORT", DEFAULT_PROXY_PORT),
    routes,
    ca,
  });

  const secret = process.env.ALCHEMY_EGRESS_CONTROL_SECRET;
  const controlPort = portFromEnv("ALCHEMY_EGRESS_CONTROL_PORT", DEFAULT_CONTROL_PORT);
  if (process.env[EGRESS_RUN_HOOK_SWITCH]) {
    // An AWS Lambda MicroVM: this process was snapshotted at build time, so
    // the control secret, the first route table and the program's env
    // arrive in the `/run` hook, served on the control port (`hooks.port`).
    yield* serveEgressControl({
      host: "0.0.0.0",
      port: controlPort,
      routes,
      hooks: {
        ready: programListening,
        run: (payload) =>
          Effect.gen(function* () {
            const config = yield* decodeRunPayload(payload ?? "{}").pipe(
              Effect.mapError(
                (cause) => new EgressProxyError({ message: "invalid run hook payload", cause }),
              ),
            );
            if (config.routes) yield* SubscriptionRef.set(routes, config.routes);
            // Read by each program at its own start (git, gh, a harness CLI).
            if (config.env) yield* Effect.sync(() => Object.assign(process.env, config.env));
            return Redacted.make(config.secret);
          }),
      },
    });
  } else if (secret) {
    yield* serveEgressControl({
      // The owner pushes route tables from outside the sandbox.
      host: "0.0.0.0",
      port: controlPort,
      routes,
      secret: Redacted.make(secret),
    });
  } else {
    yield* Effect.logWarning(
      "ALCHEMY_EGRESS_CONTROL_SECRET is not set: the egress route table cannot be updated",
    );
  }

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
