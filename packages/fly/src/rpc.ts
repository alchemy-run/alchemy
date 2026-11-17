import * as crypto from "node:crypto";
import type { HttpEffect } from "alchemy/Http";
import { RPC_PATH_PREFIX, serveRpc } from "alchemy/Rpc";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * Machine env var holding the Apps allowed to call the Service's methods,
 * comma-separated: the Apps of the Services that bind it.
 */
export const RPC_CALLERS_ENV = "ALCHEMY_FLY_RPC_CALLERS";
/** Machine env var holding the organization callers must belong to. */
export const RPC_ORG_ENV = "ALCHEMY_FLY_ORG";
/**
 * Machine env var holding the published port Alchemy added for bindings.
 * Requests on it must come from Fly's private network.
 */
export const BINDING_PORT_ENV = "ALCHEMY_FLY_BINDING_PORT";
/** Published port Alchemy adds when a Service has no plain-HTTP port. */
export const DEFAULT_BINDING_PORT = 7780;

/** Fly's signed origin header on Flycast requests, and its public key. */
const FLY_SRC_HEADER = "fly-src";
const FLY_SRC_SIGNATURE_HEADER = "fly-src-signature";
const FLY_SRC_PUBLIC_KEY = "/.fly/fly-src.pub";
/** DER prefix that wraps a raw 32-byte ed25519 key as SubjectPublicKeyInfo. */
const ED25519_SPKI_PREFIX = "302a300506032b6570032100";
/**
 * Oldest accepted `Fly-Src` timestamp, in seconds. The signature covers
 * only the header, so a short window limits replay; Fly suggests 10s, and
 * the rest allows for clock skew between its proxy and the Machine.
 */
const MAX_FLY_SRC_AGE_SECONDS = 30;

const header = (headers: Record<string, string | undefined>, name: string): string =>
  headers[name] ?? "";

let publicKey: crypto.KeyObject | undefined;

/** Load Fly's `Fly-Src` verification key once per instance. */
const loadPublicKey = Effect.gen(function* () {
  if (publicKey !== undefined) return publicKey;
  const fs = yield* FileSystem.FileSystem;
  const hex = yield* fs.readFileString(FLY_SRC_PUBLIC_KEY).pipe(
    Effect.map((text) => text.trim()),
    Effect.orElseSucceed(() => ""),
  );
  if (hex.length === 0) return undefined;
  const key = yield* Effect.try(() =>
    crypto.createPublicKey({
      key: Buffer.from(`${ED25519_SPKI_PREFIX}${hex}`, "hex"),
      format: "der",
      type: "spki",
    }),
  ).pipe(Effect.orElseSucceed(() => undefined));
  publicKey = key;
  return key;
});

/**
 * The calling App named by a valid `Fly-Src` signature from Fly's proxy for
 * a caller in `org`, or `undefined`. Fly adds the header only to requests
 * that arrive over its private network and signs who sent them, so a public
 * request can never pass and no caller can claim another App.
 */
export const verifyFlySrc = (headers: Record<string, string | undefined>, org: string) =>
  Effect.gen(function* () {
    const source = header(headers, FLY_SRC_HEADER);
    const signature = header(headers, FLY_SRC_SIGNATURE_HEADER);
    if (source.length === 0 || signature.length === 0 || org.length === 0) return undefined;
    const key = yield* loadPublicKey;
    if (key === undefined) return undefined;
    const valid = yield* Effect.try(() =>
      crypto.verify(null, Buffer.from(source), key, Buffer.from(signature, "base64")),
    ).pipe(Effect.orElseSucceed(() => false));
    if (!valid) return undefined;
    const fields = Object.fromEntries(
      source.split(";").map((pair) => {
        const at = pair.indexOf("=");
        return [pair.slice(0, at), pair.slice(at + 1)];
      }),
    );
    const now = (yield* Clock.currentTimeMillis) / 1000;
    const age = now - Number(fields.ts);
    const fresh = age >= -MAX_FLY_SRC_AGE_SECONDS && age <= MAX_FLY_SRC_AGE_SECONDS;
    return fields.org === org && fresh && fields.app ? fields.app : undefined;
  });

const unauthorized = HttpServerResponse.text("Unauthorized", { status: 401 });

/**
 * Serve a Service's RPC methods on `/__rpc__/*` and everything else with
 * `fallback`. RPC calls must carry a valid `Fly-Src` signature from the
 * Service's organization naming an App that binds the Service. Every
 * request on the port Alchemy added for bindings must carry the `Fly-Src`
 * signature, so that port never answers the public internet.
 */
export const serveFlyRpc = <Req = never>(
  shape: Record<string, unknown>,
  fallback: HttpEffect<Req>,
): HttpEffect<Req | FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const headers = request.headers as Record<string, string | undefined>;
    const isRpc = request.url.includes(RPC_PATH_PREFIX);
    const readEnv = (name: string) => Config.String(name).pipe(Effect.orElseSucceed(() => ""));
    const env = {
      bindingPort: yield* readEnv(BINDING_PORT_ENV),
      org: yield* readEnv(RPC_ORG_ENV),
      callers: yield* readEnv(RPC_CALLERS_ENV),
    };
    const bindingPort = env.bindingPort;
    const onBindingPort =
      bindingPort.length > 0 && header(headers, "fly-forwarded-port") === bindingPort;
    if (!isRpc && !onBindingPort) return yield* fallback;
    const caller = yield* verifyFlySrc(headers, env.org);
    if (caller === undefined) return unauthorized;
    // Methods answer only the Apps of the Services that bind this one.
    if (isRpc && !env.callers.split(",").includes(caller)) return unauthorized;
    return yield* serveRpc(shape, fallback);
  });

/** Methods on an impl shape that are served as RPC. */
export const rpcMethodsOf = (shape: Record<string, unknown> | undefined) =>
  Object.fromEntries(
    Object.entries(shape ?? {}).filter(
      ([key, value]) => key !== "fetch" && key !== "run" && typeof value === "function",
    ),
  );
