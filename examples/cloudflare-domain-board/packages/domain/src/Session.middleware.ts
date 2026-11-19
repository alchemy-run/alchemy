import * as Headers from "effect/http/Headers";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import { CurrentActor } from "./CurrentActor.context.ts";

/** The request has no board token, or no actor name. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}

/** The header that names who is acting: a person or an agent. */
export const ACTOR_HEADER = "x-board-actor";

/**
 * The cookies a browser signs in with: the board's token, and who it is. A
 * WebSocket upgrade carries cookies, never a header a page sets, so the web
 * app's live reads authenticate with these.
 */
export const TOKEN_COOKIE = "board_token";
export const ACTOR_COOKIE = "board_actor";

/**
 * Authenticates a request and provides who is making it as the
 * {@link CurrentActor}. A caller sends the board's token as
 * `Authorization: Bearer <token>` and its name in `x-board-actor`: the same
 * headers from the CLI, an MCP client, or a typed client. A browser sends
 * both as cookies instead, set by `POST /api/session`.
 */
export class Session extends RpcMiddleware.Service<Session, { provides: CurrentActor }>()(
  "Board/Session",
  { error: Unauthorized },
) {}

/** The headers a caller sends: the board's token, and who it is. */
export const sessionHeaders = (token: string, actor: string) => ({
  authorization: `Bearer ${token}`,
  [ACTOR_HEADER]: actor,
});

/** Client side, for typed clients: send the token and the actor with every call. */
export const sessionClient = (token: string, actor: string) =>
  RpcMiddleware.layerClient(Session, ({ request, next }) =>
    next({
      ...request,
      headers: Headers.setAll(request.headers, sessionHeaders(token, actor)),
    }),
  );
