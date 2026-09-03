import * as ZeroSsl from "@distilled.cloud/zerossl";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Socket from "effect/unstable/socket/Socket";
import * as ACME from "../../ACME/index.ts";
import * as AdoptPolicy from "../../AdoptPolicy.ts";
import * as Cloudflare from "../../Cloudflare/index.ts";
import * as Fly from "../../Fly/index.ts";
import * as Output from "../../Output.ts";
import {
  AUTH_HEADER,
  CHUNK_SIZE,
  CONNECT_PATH,
  decodeChunk,
  decodeControl,
  encodeChunk,
  encodeControl,
  forwardableHeaders,
  NAMESPACE_PARAM,
  parsePublicHost,
  type ControlFrame,
  type HelloFrame,
  type RequestFrame,
} from "./RelayProtocol.ts";

/**
 * The Alchemy dev relay — a public front door for `alchemy dev` sessions,
 * as a Fly Service.
 *
 * - The dev sidecar dials `wss://<domain>/__relay/connect?namespace=<ns>`
 *   once and keeps the socket open; the Machine that accepted it owns the
 *   namespace and records itself in the {@link RelayDirectory} (Redis).
 * - Every request for `https://<label>.<ns>.<domain>` lands on some Machine
 *   (Fly's proxy load-balances); a Machine that doesn't hold the socket
 *   answers with `fly-replay: instance=<owner>` and Fly's proxy re-sends the
 *   request to the owner, which forwards it down the socket as a multiplexed
 *   stream (see `RelayProtocol.ts`). The connector answers it from the local
 *   ingress.
 * - TLS ends at Fly's proxy. Each namespace gets its own wildcard
 *   certificate (`*.<ns>.<domain>`), issued from ZeroSSL over DNS-01 through
 *   the zone's Cloudflare records the first time the namespace connects and
 *   uploaded to the App with {@link Fly.WriteCertificates}; a background
 *   loop renews them. Let's Encrypt is not an option here only because it
 *   is unreachable from Cloudflare Workers — on Fly it would work too.
 *
 * Configured with `Config` at init — Alchemy captures the values at deploy
 * and re-resolves them from the Machine's environment at runtime:
 *
 * - `DEV_RELAY_DOMAIN` — public domain, hosts are `<label>.<ns>.<domain>`
 * - `DEV_RELAY_ZONE` — the Cloudflare zone `<domain>` lives in
 * - `DEV_RELAY_SCHEME` — `https` (default) or `http` on a TLS-less relay
 * - `DEV_RELAY_TOKEN` — optional shared bearer token connectors must present
 * - `ZERO_SSL_KEY` — ZeroSSL REST key the ACME account's EAB is minted from
 *
 * Deploy it with Alchemy itself: see `Relay.ts` and `stacks/dev-relay.ts`.
 */

const domain = Config.string("DEV_RELAY_DOMAIN").pipe(
  Config.map((value) => value.toLowerCase()),
);
const scheme = Config.string("DEV_RELAY_SCHEME").pipe(
  Config.withDefault("https"),
);
const token = Config.option(Config.redacted("DEV_RELAY_TOKEN"));

/** The Fly App the relay runs in. */
export const RelayApp = Fly.App("DevRelayApp", { enableSubdomains: true });

/** Namespace → owning Machine, and the set of namespaces to keep certificates for. */
export const RelayDirectory = Fly.Redis("DevRelayDirectory");

/** The Cloudflare zone `DEV_RELAY_DOMAIN` lives in (existing; adopted, never deleted). */
export const RelayZone = Cloudflare.Zone.Zone("DevRelayZone", {
  name: Config.string("DEV_RELAY_ZONE"),
}).pipe(AdoptPolicy.adopt());

/**
 * External Account Binding minted from `ZERO_SSL_KEY` when the stack is
 * evaluated (cached so both halves come from one pair). Only the first
 * `newAccount` consumes it; later deploys reuse the stored account.
 */
const zeroSslEab = Effect.runSync(
  Effect.cached(
    ZeroSsl.zerossl
      .generateEabCredentials({})
      .pipe(
        Effect.provide(
          Layer.mergeAll(ZeroSsl.CredentialsFromEnv, FetchHttpClient.layer),
        ),
        Effect.orDie,
      ),
  ),
);

/** The ACME account every relay certificate is issued with. */
export const RelayCertificateAccount = ACME.Account("DevRelayZeroSSL", {
  ca: ACME.ZeroSSL,
  eab: {
    keyId: Output.fromEffect(zeroSslEab.pipe(Effect.map((e) => e.eab_kid!))),
    hmacKey: Output.fromEffect(
      zeroSslEab.pipe(Effect.map((e) => e.eab_hmac_key!)),
    ),
  },
  termsOfServiceAgreed: true,
});

/** How long a public request waits for the dev session's response head. */
const RESPONSE_TIMEOUT = "30 seconds";
/** Re-issue a namespace certificate when less than this remains. */
const RENEW_BEFORE_MS = 30 * 86_400_000;
/** How often the renewal loop looks at every namespace's certificate. */
const RENEWAL_INTERVAL = "6 hours";
/** Directory entries expire unless the owner is still around to refresh them. */
const OWNER_TTL_SECONDS = 24 * 3600;

const ownerKey = (namespace: string) => `relay:owner:${namespace}`;
const NAMESPACES_KEY = "relay:namespaces";
const wildcardOf = (namespace: string, relayDomain: string) =>
  `*.${namespace}.${relayDomain}`;

interface Pending {
  readonly head: Deferred.Deferred<
    HttpServerResponse.HttpServerResponse,
    Error
  >;
  writer?: WritableStreamDefaultWriter<Uint8Array>;
}

interface Session {
  readonly namespace: string;
  readonly pending: Map<number, Pending>;
  nextId: number;
  write: (
    chunk: string | Uint8Array | Socket.CloseEvent,
  ) => Effect.Effect<void, Socket.SocketError>;
}

const page = (status: number, title: string, body: string) =>
  HttpServerResponse.text(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;padding:3rem 1.5rem;font:15px/1.5 ui-sans-serif,system-ui,sans-serif;background:#f6f6f7;color:#1c1c1e}main{max-width:40rem;margin:0 auto}h1{font-size:1.25rem;font-weight:600}code{font:.9em ui-monospace,Menlo,monospace}small{color:#6b6b70}@media(prefers-color-scheme:dark){body{background:#111113;color:#ececef}small{color:#8c8c93}}</style>
</head><body><main><h1>${title}</h1><p>${body}</p><p><small>alchemy dev relay · ${status}</small></p></main></body></html>`,
    { status, contentType: "text/html; charset=utf-8" },
  );

const escape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const timingSafeEqual = (a: string, b: string): boolean => {
  const encoder = new TextEncoder();
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < x.byteLength; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
};

const NAMESPACE_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export default class DevRelayService extends Fly.Service<DevRelayService>()(
  "DevRelay",
  {
    app: RelayApp,
    main: import.meta.url,
    port: 3000,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 512 },
  },
  Effect.gen(function* () {
    const relayDomain = yield* domain;
    const relayScheme = yield* scheme;
    const relayToken = yield* token;
    const acme = yield* ACME.IssueCertificate(RelayCertificateAccount);
    const dns = yield* Cloudflare.DNS.ReadWriteDns(RelayZone);
    const certs = yield* Fly.WriteCertificates(RelayApp);
    const directory = yield* Fly.ReadWriteRedis(RelayDirectory);
    const solver = Cloudflare.DNS.acmeDnsSolver(dns);

    /** This Machine's id — what the directory records and `fly-replay` targets. */
    const machineId = Effect.sync(() => process.env.FLY_MACHINE_ID ?? "local");

    // Namespaces whose connector socket this Machine holds.
    const sessions = new Map<string, Session>();
    // Namespaces whose certificate is being issued right now (per Machine).
    const issuing = new Set<string>();

    const authorized = (
      request: HttpServerRequest.HttpServerRequest,
    ): boolean => {
      if (Option.isNone(relayToken)) return true;
      const presented = request.headers[AUTH_HEADER]?.replace(
        /^Bearer\s+/i,
        "",
      );
      return (
        presented !== undefined &&
        timingSafeEqual(presented, Redacted.value(relayToken.value))
      );
    };

    // -------------------------------------------------------------------
    // Certificates
    // -------------------------------------------------------------------

    /** `ready` when a custom certificate for the namespace's wildcard is uploaded and not due. */
    const certificateState = (namespace: string) =>
      certs.get(wildcardOf(namespace, relayDomain)).pipe(
        Effect.map((detail) => {
          const custom = (detail?.certificates ?? []).filter(
            (c) => c.source === "custom",
          );
          if (custom.length === 0 || detail?.configured !== true) {
            return "missing" as const;
          }
          const expiresAt = Math.max(
            ...custom.map((c) => Date.parse(c.expires_at ?? "") || 0),
          );
          return expiresAt - Date.now() < RENEW_BEFORE_MS
            ? ("due" as const)
            : ("ready" as const);
        }),
        Effect.orElseSucceed(() => "missing" as const),
      );

    /**
     * Fly serves a certificate only once the hostname is "configured". It
     * cannot probe a wildcard, so proof of ownership is the
     * `_fly-ownership.<ns>.<domain>` TXT it names in `dns_requirements`:
     * publish it (idempotently) and re-run Fly's check until it passes.
     */
    const configureOwnership = (namespace: string, hostname: string) =>
      Effect.gen(function* () {
        const detail = yield* certs.get(hostname);
        const ownership = detail?.dns_requirements?.ownership;
        if (
          ownership?.name === undefined ||
          ownership.app_value === undefined
        ) {
          return yield* Effect.fail(
            new Error(`Fly reported no ownership record for ${hostname}`),
          );
        }
        const existing = yield* dns.listDnsRecords({
          type: "TXT",
          name: { exact: ownership.name },
        });
        const present = (existing.result ?? []).some(
          (r) =>
            r.name === ownership.name &&
            (r.content ?? "").replace(/^"|"$/g, "") === ownership.app_value,
        );
        if (!present) {
          yield* dns.createDnsRecord({
            type: "TXT",
            name: ownership.name,
            content: ownership.app_value,
            ttl: 60,
          });
          yield* Effect.logInfo(
            `[${namespace}] published ${ownership.name} = ${ownership.app_value}`,
          );
        }
        const configured = yield* certs.check(hostname).pipe(
          Effect.map((checked) => checked.configured === true),
          Effect.orElseSucceed(() => false),
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (ok) => ok,
            times: 40,
          }),
        );
        if (!configured) {
          return yield* Effect.fail(
            new Error(
              `Fly did not accept ownership of ${hostname} within the wait budget`,
            ),
          );
        }
      });

    /** Issue and upload the namespace's wildcard certificate. */
    const issueCertificate = (namespace: string) =>
      Effect.gen(function* () {
        const hostname = wildcardOf(namespace, relayDomain);
        yield* Effect.logInfo(`[${namespace}] issuing ${hostname}`);
        const issued = yield* acme.issue({
          identifiers: [hostname],
          solver,
        });
        yield* certs.upload({
          hostname,
          fullchain: issued.chain,
          privateKey: issued.privateKey,
        });
        yield* configureOwnership(namespace, hostname);
        yield* Effect.logInfo(
          `[${namespace}] ${hostname} uploaded (expires ${issued.notAfter})`,
        );
      });

    // Last issuance failure per namespace, echoed in hello so the developer
    // sees why HTTPS is not working instead of hunting for Machine logs.
    const certificateErrors = new Map<string, string>();

    const hello = (
      namespace: string,
      certificate: HelloFrame["certificate"],
    ): HelloFrame => ({
      t: "hello",
      namespace,
      domain: relayDomain,
      scheme: relayScheme,
      certificate,
      certificateError:
        certificate === "unavailable"
          ? certificateErrors.get(namespace)
          : undefined,
    });

    /**
     * Make sure the namespace has a certificate: `ready` now, or
     * `provisioning` with issuance running in the background — the session
     * gets a fresh hello when it lands.
     */
    const ensureCertificate = (namespace: string) =>
      Effect.gen(function* () {
        if (relayScheme !== "https") return undefined;
        const state = yield* certificateState(namespace);
        if (state === "ready") return "ready" as const;
        if (!issuing.has(namespace)) {
          issuing.add(namespace);
          yield* issueCertificate(namespace).pipe(
            Effect.map(() => {
              certificateErrors.delete(namespace);
              return "ready" as const;
            }),
            Effect.catchCause((cause) =>
              Effect.logError(
                `[${namespace}] certificate issuance failed:\n${cause}`,
              ).pipe(
                Effect.tap(() =>
                  Effect.sync(() =>
                    certificateErrors.set(
                      namespace,
                      Cause.pretty(cause).slice(0, 2000),
                    ),
                  ),
                ),
                Effect.as("unavailable" as const),
              ),
            ),
            Effect.tap((result) =>
              Effect.gen(function* () {
                issuing.delete(namespace);
                const session = sessions.get(namespace);
                if (session) {
                  yield* session
                    .write(encodeControl(hello(namespace, result)))
                    .pipe(Effect.ignore);
                }
              }),
            ),
            Effect.forkDetach,
          );
        }
        // A certificate that is merely due keeps serving while it renews.
        return state === "due" ? ("ready" as const) : ("provisioning" as const);
      });

    /** Renew every namespace's certificate that is due. Runs forever. */
    const renewalLoop = Effect.gen(function* () {
      const namespaces = yield* directory
        .smembers(NAMESPACES_KEY)
        .pipe(Effect.orElseSucceed(() => [] as string[]));
      for (const namespace of namespaces) {
        const state = yield* certificateState(namespace);
        if (state !== "due") continue;
        yield* issueCertificate(namespace).pipe(
          Effect.catchCause((cause) =>
            Effect.logError(`[${namespace}] renewal failed:\n${cause}`),
          ),
        );
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logError(`renewal loop:\n${cause}`)),
      Effect.repeat(Schedule.spaced(RENEWAL_INTERVAL)),
      Effect.asVoid,
    );

    // -------------------------------------------------------------------
    // Sessions
    // -------------------------------------------------------------------

    const settle = (session: Session, frame: ControlFrame) =>
      Effect.sync(() => {
        const { pending } = session;
        switch (frame.t) {
          case "res": {
            const entry = pending.get(frame.id);
            if (!entry) return;
            const headers = Headers.fromInput(frame.headers);
            if (!frame.body) {
              pending.delete(frame.id);
              Deferred.doneUnsafe(
                entry.head,
                Effect.succeed(
                  HttpServerResponse.empty({ status: frame.status, headers }),
                ),
              );
              return;
            }
            const { readable, writable } = new TransformStream<
              Uint8Array,
              Uint8Array
            >();
            entry.writer = writable.getWriter();
            Deferred.doneUnsafe(
              entry.head,
              Effect.succeed(
                HttpServerResponse.stream(
                  Stream.fromReadableStream({
                    evaluate: () => readable,
                    onError: (error) => error,
                  }),
                  { status: frame.status, headers },
                ),
              ),
            );
            return;
          }
          case "end": {
            const entry = pending.get(frame.id);
            if (!entry) return;
            pending.delete(frame.id);
            void entry.writer?.close().catch(() => {});
            return;
          }
          case "abort": {
            const entry = pending.get(frame.id);
            if (!entry) return;
            pending.delete(frame.id);
            const error = new Error(
              frame.message ?? "aborted by the dev session",
            );
            if (entry.writer) void entry.writer.abort(error).catch(() => {});
            else Deferred.doneUnsafe(entry.head, Effect.fail(error));
            return;
          }
          case "hello":
          case "req":
            return;
        }
      });

    const failAll = (session: Session, message: string) =>
      Effect.sync(() => {
        for (const [id, entry] of session.pending) {
          session.pending.delete(id);
          const error = new Error(message);
          if (entry.writer) void entry.writer.abort(error).catch(() => {});
          else Deferred.doneUnsafe(entry.head, Effect.fail(error));
        }
      });

    /** Accept a connector socket and serve it until it closes. */
    const connect = Effect.fn("DevRelay.connect")(function* (
      request: HttpServerRequest.HttpServerRequest,
      namespace: string,
    ) {
      const self = yield* machineId;
      const socket = yield* request.upgrade;
      const session: Session = {
        namespace,
        pending: new Map(),
        nextId: 1,
        // Filled in once the socket is running (below).
        write: () => Effect.void,
      };
      // `run` is what completes the handshake and drives the socket: start
      // it first, then write. Node hands every frame over as bytes, so a
      // control frame (JSON, starts with `{`) is told apart from a body
      // chunk (4-byte stream id, first byte 0) by its first byte.
      const reader = yield* socket
        .runRaw((data) => {
          const bytes = typeof data === "string" ? undefined : data;
          if (typeof data === "string" || bytes![0] === 0x7b) {
            const text =
              typeof data === "string" ? data : new TextDecoder().decode(bytes);
            return settle(session, decodeControl(text));
          }
          return Effect.sync(() => {
            const { id, chunk } = decodeChunk(bytes!);
            const entry = session.pending.get(id);
            // Copy: the frame's buffer is reused by the runtime.
            void entry?.writer?.write(new Uint8Array(chunk)).catch(() => {});
          });
        })
        .pipe(Effect.ignore, Effect.forkScoped);
      const write = yield* socket.writer;
      session.write = write;
      // A new connector replaces the previous (restarted) session.
      const previous = sessions.get(namespace);
      if (previous) {
        yield* failAll(previous, "replaced by a newer connector");
        yield* previous
          .write(new Socket.CloseEvent(4000, "replaced by a newer connector"))
          .pipe(Effect.ignore);
      }
      sessions.set(namespace, session);
      yield* directory
        .set(ownerKey(namespace), self, { ex: OWNER_TTL_SECONDS })
        .pipe(Effect.ignore);
      yield* directory.sadd(NAMESPACES_KEY, namespace).pipe(Effect.ignore);

      const certificate = yield* ensureCertificate(namespace);
      yield* write(encodeControl(hello(namespace, certificate))).pipe(
        Effect.ignore,
      );
      yield* Effect.logInfo(`[${namespace}] connector attached to ${self}`);

      // Serve until the socket closes; refresh the directory lease meanwhile.
      const lease = directory
        .expire(ownerKey(namespace), OWNER_TTL_SECONDS)
        .pipe(
          Effect.ignore,
          Effect.repeat(Schedule.spaced("1 hour")),
          Effect.forkScoped,
        );
      yield* lease;
      yield* Fiber.join(reader);

      yield* failAll(session, "the dev session disconnected");
      if (sessions.get(namespace) === session) {
        sessions.delete(namespace);
        // Only the owner clears its own entry; a replacement elsewhere
        // already overwrote it.
        const owner = yield* directory
          .get(ownerKey(namespace))
          .pipe(Effect.orElseSucceed(() => null));
        if (owner === self) {
          yield* directory.del(ownerKey(namespace)).pipe(Effect.ignore);
        }
      }
      yield* Effect.logInfo(`[${namespace}] connector detached`);
      return HttpServerResponse.empty();
    });

    /** Forward one public request down the session's socket and await its response. */
    const relay = Effect.fn("DevRelay.relay")(function* (
      request: HttpServerRequest.HttpServerRequest,
      session: Session,
      host: string,
      label: string,
    ) {
      const id = session.nextId++;
      const url = new URL(request.url, "http://relay");
      const headers = Headers.setAll(request.headers, {
        "x-forwarded-host": host,
        "x-forwarded-proto": relayScheme,
      });
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const frame: RequestFrame = {
        t: "req",
        id,
        method: request.method,
        url: `${url.pathname}${url.search}`,
        host,
        label,
        headers: forwardableHeaders(Object.entries(headers)),
        body: hasBody,
      };
      const head = yield* Deferred.make<
        HttpServerResponse.HttpServerResponse,
        Error
      >();
      session.pending.set(id, { head });
      yield* session.write(encodeControl(frame)).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            session.pending.delete(id);
            Deferred.doneUnsafe(head, Effect.fail(new Error(String(error))));
          }),
        ),
      );
      if (hasBody) {
        // Pump the body in bounded chunks; the response head can arrive
        // before the body finishes, so this runs detached from the request.
        yield* request.stream.pipe(
          Stream.flatMap((bytes) => {
            const chunks: Uint8Array[] = [];
            for (let o = 0; o < bytes.byteLength; o += CHUNK_SIZE) {
              chunks.push(bytes.subarray(o, o + CHUNK_SIZE));
            }
            return Stream.fromIterable(chunks);
          }),
          Stream.runForEach((chunk) => session.write(encodeChunk(id, chunk))),
          Effect.andThen(session.write(encodeControl({ t: "end", id }))),
          Effect.catch((error) =>
            session.write(
              encodeControl({ t: "abort", id, message: String(error) }),
            ),
          ),
          Effect.ignore,
          Effect.forkDetach,
        );
      }
      return yield* Deferred.await(head).pipe(
        Effect.timeoutOrElse({
          duration: RESPONSE_TIMEOUT,
          orElse: () =>
            Effect.sync(() => {
              session.pending.delete(id);
              return page(
                504,
                "No response from alchemy dev",
                "The dev session did not answer in time.",
              );
            }),
        }),
        Effect.catch((error) =>
          Effect.succeed(
            page(504, "No response from alchemy dev", escape(error.message)),
          ),
        ),
      );
    });

    let renewing = false;

    return {
      fetch: Effect.gen(function* () {
        if (!renewing) {
          // Init also runs at deploy time; only a serving Machine renews.
          renewing = true;
          yield* renewalLoop.pipe(Effect.forkDetach);
        }
        const request = yield* HttpServerRequest.HttpServerRequest;
        const host = request.headers.host ?? "";
        const hostname = host.split(":")[0]!.toLowerCase();
        const url = new URL(request.url, "http://relay");

        if (hostname === relayDomain && url.pathname === CONNECT_PATH) {
          if (request.headers.upgrade?.toLowerCase() !== "websocket") {
            return page(
              426,
              "Upgrade required",
              "Connect with a WebSocket client.",
            );
          }
          if (!authorized(request)) {
            return HttpServerResponse.text("unauthorized", { status: 401 });
          }
          const namespace = url.searchParams
            .get(NAMESPACE_PARAM)
            ?.toLowerCase();
          if (!namespace || !NAMESPACE_PATTERN.test(namespace)) {
            return HttpServerResponse.text("invalid or missing namespace", {
              status: 400,
            });
          }
          return yield* connect(request, namespace);
        }

        if (hostname === relayDomain) {
          return page(
            200,
            "alchemy dev relay",
            `Run <code>alchemy dev --relay ${escape(`${relayScheme}://${relayDomain}`)}</code> to get stable <code>https://&lt;name&gt;.&lt;namespace&gt;.${escape(relayDomain)}</code> URLs for your local resources.`,
          );
        }

        const target = parsePublicHost(host, relayDomain);
        if (target === undefined) {
          return page(
            404,
            "Unknown host",
            `Nothing is served at <code>${escape(host)}</code>.`,
          );
        }
        if (request.headers.upgrade?.toLowerCase() === "websocket") {
          return page(
            501,
            "WebSockets are not relayed yet",
            "The dev relay forwards HTTP requests; WebSocket passthrough is on its way.",
          );
        }
        const session = sessions.get(target.namespace);
        if (session !== undefined) {
          return yield* relay(request, session, host, target.label);
        }
        // Not ours: the owning Machine (if any) gets the request replayed.
        const self = yield* machineId;
        const owner = yield* directory
          .get(ownerKey(target.namespace))
          .pipe(Effect.orElseSucceed(() => null));
        if (owner !== null && owner !== self) {
          return HttpServerResponse.empty({
            status: 200,
            headers: Headers.fromInput({ "fly-replay": `instance=${owner}` }),
          });
        }
        return page(
          502,
          "alchemy dev is not connected",
          `No dev session is connected for <code>${escape(host)}</code>. Start <code>alchemy dev</code> with the relay enabled and retry.`,
        );
      }),
    };
  }).pipe(
    Effect.provide(ACME.IssueCertificateHttp),
    Effect.provide(Cloudflare.DNS.ReadWriteDnsHttp),
    Effect.provide(Fly.WriteCertificatesHttp),
    Effect.provide(Fly.ReadWriteRedisHttp),
  ),
) {}
