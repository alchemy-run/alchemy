import { ActorName } from "@board/domain/Actor";
import { CurrentActor } from "@board/domain/CurrentActor.context";
import {
  ACTOR_COOKIE,
  ACTOR_HEADER,
  Session,
  TOKEN_COOKIE,
  Unauthorized,
} from "@board/domain/Session.middleware";
import * as Alchemy from "alchemy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Cookies from "effect/http/Cookies";
import * as Headers from "effect/http/Headers";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

/** The board's token: everyone who holds it may act on the board, under any name. */
export class BoardToken extends Context.Service<
  BoardToken,
  Effect.Effect<Redacted.Redacted<string>>
>()("Board/BoardToken") {}

/** A random token, made once when the stage is first deployed and kept in its state. */
export const BoardTokenLive = Layer.effect(
  BoardToken,
  Effect.gen(function* () {
    const token = yield* Alchemy.Random("BoardToken");
    return yield* token.text;
  }),
);

/** Compare in constant time, so a wrong token's prefix tells nothing. */
const sameToken = (a: string, b: string) => {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
};

const cookieOf = (headers: Headers.Headers, name: string) =>
  Option.flatMap(Headers.get(headers, "cookie"), (cookie) =>
    Option.fromNullishOr(Cookies.parseHeader(cookie)[name]),
  );

/** The token a request carries: `Authorization: Bearer` (scripts, agents), or its cookie (browsers). */
const tokenOf = (headers: Headers.Headers) =>
  Option.orElse(
    Option.flatMap(Headers.get(headers, "authorization"), (value) =>
      value.startsWith("Bearer ") ? Option.some(value.slice("Bearer ".length)) : Option.none(),
    ),
    () => cookieOf(headers, TOKEN_COOKIE),
  );

const actorName = (name: string) =>
  Schema.decodeUnknownOption(ActorName)(name).pipe(Option.filter((name) => name.length > 0));

/** Who a request says it is: `x-board-actor`, or its cookie. */
const actorOf = (headers: Headers.Headers) =>
  Option.flatMap(
    Option.orElse(Headers.get(headers, ACTOR_HEADER), () => cookieOf(headers, ACTOR_COOKIE)),
    actorName,
  );

/** Who a request acts as, if it carries the board's token and a name. */
const signedIn = Effect.fn(function* (headers: Headers.Headers) {
  const expected = Redacted.value(yield* yield* BoardToken);
  const token = tokenOf(headers);
  return Option.isSome(token) && sameToken(token.value, expected)
    ? actorOf(headers)
    : Option.none<ActorName>();
});

/**
 * The {@link Session} middleware: a request with the board's token and a name
 * in `x-board-actor` acts as that name. Anything else is Unauthorized.
 *
 * One shared token keeps the example small. Per-actor tokens, or grants
 * scoped to channels, would be checked here.
 */
export const SessionLive = Layer.effect(
  Session,
  Effect.gen(function* () {
    const token = yield* BoardToken;
    return (effect, { headers }) =>
      signedIn(headers).pipe(
        Effect.provideService(BoardToken, token),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new Unauthorized()),
            onSome: (actor) => Effect.provideService(effect, CurrentActor, actor),
          }),
        ),
      );
  }),
);

const SignIn = Schema.Struct({ token: Schema.String, actor: Schema.String });

/**
 * `/api/session`, for the web app. `POST { token, actor }` signs a browser in
 * by setting both cookies; `GET` answers who it is signed in as; `DELETE`
 * signs it out. `HttpOnly` keeps the token from the page's scripts, and
 * `SameSite=Strict` keeps the cookies off cross-site requests, WebSocket
 * upgrades included.
 */
export const sessionRoute = Effect.gen(function* () {
  const request = yield* HttpServerRequest;
  const options = { httpOnly: true, secure: true, sameSite: "strict", path: "/" } as const;
  if (request.method === "GET") {
    const actor = yield* signedIn(request.headers);
    return Option.match(actor, {
      onNone: () => HttpServerResponse.empty({ status: 401 }),
      onSome: (actor) => HttpServerResponse.jsonUnsafe({ actor }),
    });
  }
  if (request.method === "DELETE") {
    return HttpServerResponse.empty({ status: 204 }).pipe(
      HttpServerResponse.setCookieUnsafe(TOKEN_COOKIE, "", { ...options, maxAge: 0 }),
      HttpServerResponse.setCookieUnsafe(ACTOR_COOKIE, "", { ...options, maxAge: 0 }),
    );
  }
  if (request.method !== "POST") return HttpServerResponse.empty({ status: 405 });
  const body = yield* request.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SignIn)),
    Effect.option,
  );
  if (Option.isNone(body)) {
    return HttpServerResponse.text("Expected { token, actor }", { status: 400 });
  }
  const { token, actor } = body.value;
  const expected = Redacted.value(yield* yield* BoardToken);
  if (!sameToken(token, expected) || Option.isNone(actorName(actor))) {
    return HttpServerResponse.empty({ status: 401 });
  }
  return HttpServerResponse.jsonUnsafe({ actor }).pipe(
    HttpServerResponse.setCookieUnsafe(TOKEN_COOKIE, token, { ...options, maxAge: "30 days" }),
    HttpServerResponse.setCookieUnsafe(ACTOR_COOKIE, actor, { ...options, maxAge: "30 days" }),
  );
});
