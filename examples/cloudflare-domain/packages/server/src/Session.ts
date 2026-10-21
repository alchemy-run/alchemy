import { type Actor, agent, customer } from "@bank/domain/Actor";
import { CurrentActor } from "@bank/domain/CurrentActor.context";
import { CustomerId } from "@bank/domain/Customer/Customer.id";
import { SESSION_COOKIE, Session, Unauthorized } from "@bank/domain/Session.middleware";
import * as Effect from "effect/Effect";
import * as Cookies from "effect/http/Cookies";
import * as Headers from "effect/http/Headers";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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
 * Who a request is from: its session cookie (browsers), or `Authorization`
 * (scripts). Demo verifier: the session cookie (`customer:<id>`, from
 * {@link sessionRoute}), or `Authorization: Bearer customer:<id>` /
 * `Bearer agent:<id>`. In production, sign the cookie (or keep sessions
 * server-side) and verify a Cloudflare Access JWT for agents.
 */
export const actorOf = (headers: Headers.Headers): Option.Option<Actor> =>
  Option.orElse(fromCookie(headers), () => fromAuthorization(headers));

/** The {@link Session} middleware: provides the request's actor, or fails with Unauthorized. */
export const SessionLive = Layer.succeed(Session, (effect, { headers }) =>
  Option.match(actorOf(headers), {
    onNone: () => Effect.fail(new Unauthorized()),
    onSome: (actor) => Effect.provideService(effect, CurrentActor, actor),
  }),
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
