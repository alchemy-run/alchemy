/**
 * Shared scaffolding for the Discord `*Http` binding implementations —
 * the Discord analogue of the GitHub `BindingHttp.ts` convention.
 *
 * `make(op)` builds the TOKEN-BACKED implementation: it captures the
 * provider's credential as a {@link BotToken} resource named after the
 * host (`${LogicalId}DiscordBotToken` — FQN-memoized, so every Discord
 * binding on one host shares ONE token resource), and authenticates
 * each operation with the token's bound `value`. Yielding the
 * attribute from the host's init Effect is what binds it into the
 * deployed environment; at runtime the same accessor reads it back.
 *
 * The per-operation sandwich itself (wrap each call in a traced span
 * with typed wire errors) is {@link makeOperationClient} — shared with
 * the `*Local` layers (BindingLocal.ts), which run the SAME operations
 * off the provider's ambient credentials instead of a bound token.
 *
 * NOT exported from `index.ts` (internal scaffolding).
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { Self } from "../Self.ts";
import { DiscordApiError } from "./ApiError.ts";
import { BotToken } from "./BotToken.ts";

const API = "https://discord.com/api/v10";

/** One wire request as an operation's `call` describes it. */
export interface RestRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path under `/api/v10`, e.g. `/channels/{id}/messages`. */
  readonly path: string;
  readonly body?: unknown;
  readonly query?: Record<string, string | number | undefined>;
}

/** The minimal typed REST caller both binding families share. */
export interface DiscordRest {
  readonly request: <A>(
    options: RestRequest,
  ) => Effect.Effect<A, DiscordApiError>;
}

/**
 * Build a {@link DiscordRest} over an `HttpClient` and a bot token.
 * `operation` names the traced span and the `operation` field of every
 * {@link DiscordApiError}.
 */
export const makeRest = (
  client: HttpClient.HttpClient,
  operation: string,
  token: Redacted.Redacted<string>,
): DiscordRest => ({
  request: <A>({ method, path, body, query }: RestRequest) =>
    Effect.gen(function* () {
      const search = Object.entries(query ?? {})
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
        .join("&");
      let request = HttpClientRequest.make(method)(
        `${API}${path}${search.length > 0 ? `?${search}` : ""}`,
      ).pipe(
        HttpClientRequest.setHeaders({
          Authorization: `Bot ${Redacted.value(token)}`,
        }),
      );
      if (body !== undefined) {
        request = HttpClientRequest.bodyJsonUnsafe(request, body);
      }
      const response = yield* client
        .execute(request)
        .pipe(
          Effect.mapError(
            (cause) =>
              new DiscordApiError({ operation, message: String(cause) }),
          ),
        );
      const payload = yield* response.json.pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (response.status < 200 || response.status >= 300) {
        return yield* new DiscordApiError({
          operation,
          status: response.status,
          message:
            (payload as { message?: string } | undefined)?.message ??
            `HTTP ${response.status}`,
        });
      }
      return payload as A;
    }),
});

/**
 * One Discord operation, declared ONCE and implemented by both the
 * `*Http` (token-backed) and `*Local` (ambient-credentials) layers.
 * `name` becomes the traced span (`Discord.channels.listMessages`) and
 * the `operation` field of every {@link DiscordApiError}.
 */
export interface Operation<Request extends ReadonlyArray<any>, Out> {
  readonly name: string;
  readonly call: (
    rest: DiscordRest,
  ) => (...request: Request) => Effect.Effect<Out, DiscordApiError>;
}

export const operation = <Request extends ReadonlyArray<any>, Out>(
  name: string,
  call: Operation<Request, Out>["call"],
): Operation<Request, Out> => ({ name, call });

/**
 * The operation sandwich over ANY token source — wrap each call in a
 * traced span with typed wire errors.
 */
export const makeOperationClient = <Request extends ReadonlyArray<any>, Out>(
  op: Operation<Request, Out>,
  client: HttpClient.HttpClient,
  token: Effect.Effect<Redacted.Redacted<string>>,
) =>
  Effect.fn(function* () {
    return Effect.fn(`Discord.${op.name}`)(function* (...request: Request) {
      const rest = makeRest(client, op.name, yield* token);
      return yield* op.call(rest)(...request);
    });
  });

/**
 * Build the token-backed implementation Effect of a Discord binding —
 * pass the result straight to `Layer.effect(Tag, …)`:
 *
 * ```ts
 * export const ListMessagesHttp = Layer.effect(
 *   ListMessages,
 *   BindingHttp.make(listMessagesOperation),
 * );
 * ```
 */
export const make = <Request extends ReadonlyArray<any>, Out>(
  op: Operation<Request, Out>,
) =>
  Effect.gen(function* () {
    const Token = yield* BotToken;
    const self = yield* Self;
    const client = yield* HttpClient.HttpClient;
    // ONE token resource per host (FQN-memoized across every Discord
    // binding the host uses). At deploy this captures + validates the
    // provider credential; yielding `value` below binds it into the
    // host's environment, and at runtime the same accessor reads it
    // back — the client authenticates with the BOUND token, never the
    // deploy-time ambient credential.
    const token = yield* Token(`${self.LogicalId}DiscordBotToken`, {});
    const value = yield* token.value;
    return makeOperationClient(op, client, value);
  });
