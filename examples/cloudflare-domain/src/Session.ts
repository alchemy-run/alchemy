import * as Effect from "effect/Effect";
import * as Cookies from "effect/http/Cookies";
import * as Headers from "effect/http/Headers";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import { type Actor, agent, customer } from "./Actor.ts";
import { CurrentActor } from "./CurrentActor.ts";
import { CustomerId } from "./Customer/CustomerId.ts";
import { Unauthorized } from "./Unauthorized.ts";

/** The cookie that carries a customer's session in a browser. */
export const SESSION_COOKIE = "bank_session";

/**
 * Authenticates a request, from a customer or a support agent, and provides
 * who is making it as the {@link CurrentActor}. Authorization is up to each
 * command's `decide` and each view's `validate`.
 *
 * Browsers authenticate with the session cookie, which also reaches live
 * reads: a WebSocket upgrade carries cookies, never a header a client sets.
 * Other clients (tests, support tooling) send `Authorization` instead.
 */
export class Session extends RpcMiddleware.Service<Session, { provides: CurrentActor }>()(
  "Bank/Session",
  { error: Unauthorized },
) {}

const parse = (token: string): Option.Option<Actor> => {
  const match = /^(customer|agent):(.+)$/.exec(token);
  if (!match) return Option.none();
  return Option.some(match[1] === "customer" ? customer(match[2]!) : agent(match[2]!));
};

const fromCookie = (headers: Headers.Headers): Option.Option<Actor> =>
  Option.flatMap(Headers.get(headers, "cookie"), (cookie) =>
    Option.flatMap(Option.fromNullishOr(Cookies.parseHeader(cookie)[SESSION_COOKIE]), (token) =>
      Option.filter(parse(token), (actor) => actor._tag === "Customer"),
    ),
  );

const fromAuthorization = (headers: Headers.Headers): Option.Option<Actor> =>
  Option.flatMap(Headers.get(headers, "authorization"), (value) =>
    value.startsWith("Bearer ") ? parse(value.slice("Bearer ".length)) : Option.none(),
  );

/**
 * Demo verifier: the session cookie (`customer:<id>`, from {@link sessionRoute}),
 * or `Authorization: Bearer customer:<id>` / `Bearer agent:<id>`. In
 * production, sign the cookie (or keep sessions server-side) and verify a
 * Cloudflare Access JWT for agents.
 */
export const SessionLive = Layer.succeed(Session, (effect, { headers }) =>
  Option.match(
    Option.orElse(fromCookie(headers), () => fromAuthorization(headers)),
    {
      onNone: () => Effect.fail(new Unauthorized()),
      onSome: (actor) => Effect.provideService(effect, CurrentActor, actor),
    },
  ),
);

const SignIn = Schema.Struct({ customerId: CustomerId });

/**
 * `POST /api/session` signs a customer in by setting the session cookie;
 * `DELETE` signs them out. `HttpOnly` keeps it from scripts, and
 * `SameSite=Strict` keeps it off cross-site requests, WebSocket upgrades
 * included. Demo only: anyone may sign in as anyone.
 */
export const sessionRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest;
  const options = { httpOnly: true, secure: true, sameSite: "strict", path: "/" } as const;
  if (request.method === "DELETE") {
    return HttpServerResponse.empty({ status: 204 }).pipe(
      HttpServerResponse.setCookieUnsafe(SESSION_COOKIE, "", { ...options, maxAge: 0 }),
    );
  }
  if (request.method !== "POST") return HttpServerResponse.empty({ status: 405 });
  const body = yield* request.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SignIn)),
    Effect.option,
  );
  if (Option.isNone(body))
    return HttpServerResponse.text("Expected { customerId }", { status: 400 });
  return HttpServerResponse.empty({ status: 204 }).pipe(
    HttpServerResponse.setCookieUnsafe(
      SESSION_COOKIE,
      `customer:${body.value.customerId}`,
      options,
    ),
  );
});

/** Client side, for clients that are not browsers: send this token with every call. */
export const sessionClient = (token: string) =>
  RpcMiddleware.layerClient(Session, ({ request, next }) =>
    next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${token}`) }),
  );
