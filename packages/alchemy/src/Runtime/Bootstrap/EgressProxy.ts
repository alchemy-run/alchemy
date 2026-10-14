/**
 * Start the in-sandbox egress proxy (Egress/Proxy.ts) before the program
 * when the image was built with egress support (`ALCHEMY_EGRESS_PROXY`).
 * The first route table arrives in `ALCHEMY_EGRESS_ROUTES`; the owner
 * replaces it at run time through the control endpoint, authenticated with
 * `ALCHEMY_EGRESS_CONTROL_SECRET`.
 *
 * Everything the program starts (git, gh, a harness CLI) inherits
 * `HTTPS_PROXY` and a CA bundle that trusts the proxy's per-sandbox CA.
 */
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
  if (secret) {
    yield* serveEgressControl({
      // The owner pushes route tables from outside the sandbox.
      host: "0.0.0.0",
      port: portFromEnv("ALCHEMY_EGRESS_CONTROL_PORT", DEFAULT_CONTROL_PORT),
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
