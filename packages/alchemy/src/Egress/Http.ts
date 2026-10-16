import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import type { RuntimeContext } from "../RuntimeContext.ts";
import {
  cachedLookup,
  CREDENTIAL_TTL_MILLIS,
  type CredentialInput,
  egressSecret,
  type EgressSecret,
  refuse,
} from "./Handler.ts";
import {
  checkSubject,
  type ConfiguredEgress,
  ConfiguredEgressTypeId,
  type EgressKind,
  EgressKindTypeId,
  EgressNotServed,
  type EgressRequest,
} from "./Kind.ts";
import { mostSpecific } from "./Route.ts";

/** Where an HTTP egress goes and what it adds to each request. */
export interface HttpCredential {
  /** The host requests go to, e.g. `api.stripe.com`. */
  readonly host: string;
  /** Path patterns within the host (`*` one segment, `**` any). Absent: the whole host. */
  readonly paths?: ReadonlyArray<string>;
  /** Headers set on every request (replacing what the sandbox sent). */
  readonly headers: Readonly<Record<string, string | Redacted.Redacted<string>>>;
}

/** A static HTTP credential: header values may be secrets bound into the gateway's host. */
export interface StaticHttpCredential {
  readonly host: string;
  readonly paths?: ReadonlyArray<string>;
  readonly headers: Readonly<Record<string, string | EgressSecret>>;
}

/** Narrow an HTTP egress to some of its paths. */
export interface HttpScope {
  readonly paths: ReadonlyArray<string>;
}

export interface HttpOptions {
  /**
   * The host, paths and headers: static, or a function of the grant's
   * subject (looked up per request, cached per subject briefly).
   */
  readonly credential:
    | StaticHttpCredential
    | ((input: CredentialInput) => Effect.Effect<HttpCredential, unknown, RuntimeContext>);
}

/** The `Egress.Http` kind, as named in a gateway or sandbox declaration. */
export interface HttpKind extends EgressKind<"Http", HttpScope> {
  (options: HttpOptions): Effect.Effect<ConfiguredEgress<"Http">>;
}

const makeHttp = (options: HttpOptions): Effect.Effect<ConfiguredEgress<"Http">> =>
  Effect.gen(function* () {
    const { credential } = options;
    let lookup: (
      subject: string | undefined,
    ) => Effect.Effect<HttpCredential, EgressNotServed, RuntimeContext>;
    let perSubject: boolean;
    if (typeof credential === "function") {
      perSubject = true;
      const cached = cachedLookup(CREDENTIAL_TTL_MILLIS, (subject: string) =>
        credential({ subject }).pipe(
          Effect.mapError(
            (cause) =>
              new EgressNotServed({
                message: `no credential for ${subject}: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          ),
        ),
      );
      lookup = (subject) =>
        subject === undefined
          ? Effect.fail(new EgressNotServed({ message: "this egress needs a subject: use for()" }))
          : cached(subject);
    } else {
      perSubject = false;
      const headers: Array<readonly [string, Effect.Effect<string | Redacted.Redacted<string>>]> =
        [];
      for (const [name, value] of Object.entries(credential.headers)) {
        headers.push([
          name,
          typeof value === "string"
            ? Effect.succeed(value)
            : yield* egressSecret(
                value,
                `ALCHEMY_EGRESS_HTTP_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`,
              ),
        ]);
      }
      lookup = () =>
        Effect.map(
          Effect.forEach(headers, ([name, value]) => Effect.map(value, (v) => [name, v] as const)),
          (resolved): HttpCredential => ({
            host: credential.host,
            ...(credential.paths ? { paths: credential.paths } : {}),
            headers: Object.fromEntries(resolved),
          }),
        );
    }

    const routes = (request: EgressRequest) =>
      Effect.gen(function* () {
        const resolved = yield* lookup(request.subject);
        const scope = request.scope as HttpScope | undefined;
        if (scope !== undefined) {
          if (!Array.isArray(scope?.paths) || scope.paths.some((p) => typeof p !== "string")) {
            return yield* new EgressNotServed({ message: "an HTTP scope is { paths: string[] }" });
          }
          // A narrowed path must lie within the credential's paths.
          if (resolved.paths) {
            const outside = scope.paths.find(
              (path) =>
                !mostSpecific(
                  [{ host: resolved.host, paths: resolved.paths }],
                  resolved.host,
                  path.replace(/\/?\*\*$/, ""),
                ),
            );
            if (outside !== undefined) {
              return yield* new EgressNotServed({
                message: `${outside} is outside this egress's paths`,
              });
            }
          }
          return [{ host: resolved.host, paths: scope.paths }];
        }
        return [{ host: resolved.host, ...(resolved.paths ? { paths: resolved.paths } : {}) }];
      });

    return {
      [ConfiguredEgressTypeId]: "Http",
      perSubject,
      allows: (request) =>
        checkSubject(perSubject, request).pipe(Effect.andThen(routes(request)), Effect.asVoid),
      routes,
      handler: (request) =>
        Effect.map(
          lookup(request.subject),
          (resolved) => (outgoing: HttpClientRequest.HttpClientRequest) =>
            Effect.sync(() => {
              const url = new URL(outgoing.url);
              if (url.host.toLowerCase() !== resolved.host.toLowerCase()) {
                return refuse(`${url.host} is not this egress's host`);
              }
              let rewritten = outgoing;
              for (const [name, value] of Object.entries(resolved.headers)) {
                rewritten = HttpClientRequest.setHeader(
                  rewritten,
                  name,
                  Redacted.isRedacted(value) ? Redacted.value(value) : value,
                );
              }
              return rewritten;
            }),
        ),
      env: {},
      tools: [],
    } satisfies ConfiguredEgress<"Http">;
  });

/**
 * An egress to any HTTP host: requests to the credential's host (and paths)
 * get its headers in the gateway, so the sandbox never sees them. The
 * credential can be static, or a function of the grant's subject (whose host,
 * paths and headers all come from, e.g., a database).
 *
 * ### Adding a credential to an API
 * **Example:** A bearer token the sandbox never sees
 * ```typescript
 * export class ApiGateway extends Egress.Gateway<ApiGateway>()("ApiGateway", {
 *   stripe: Egress.Http,
 * }) {}
 *
 * export default Cloudflare.Worker(
 *   "ApiGatewayWorker",
 *   { main: import.meta.url },
 *   ApiGateway.serve(
 *     Effect.gen(function* () {
 *       return {
 *         stripe: yield* Egress.Http({
 *           credential: {
 *             host: "api.stripe.com",
 *             headers: { authorization: Config.Redacted("STRIPE_AUTHORIZATION") },
 *           },
 *         }),
 *       };
 *     }),
 *   ),
 * );
 * ```
 *
 * @binding
 * @product Egress
 * @category Egress
 */
export const Http: HttpKind = Object.assign(makeHttp, {
  [EgressKindTypeId]: "Http" as const,
});

/** The `Egress.Http` kind, as a type (`AI.Sandbox<…, { egress: Egress.Http }>`). */
export type Http = HttpKind;
