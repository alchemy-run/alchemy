import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { MANAGER_ADDRESS } from "../engineering/Triage.ts";
import { inWorker } from "../platform/Database.ts";
import { PRODUCT_ADDRESS } from "../product/Group.ts";
import { ROOT } from "../Root.ts";

/**
 * The CHANNELS — one per `AI.Group`, because every group has a channel
 * at its core: the session of its HEAD. `#root` is the Root Group's
 * (the Head's session — the humans' conversation with the company);
 * `#engineering` is the Engineering group's (the manager's session —
 * where GitHub events arrive as messages and get worked one by one).
 * A new group in code is a new channel here.
 *
 * - `GET  /api/channels`             — the list (name + chat id)
 * - `POST /api/chats/:id/stop`       — park the channel: the round is
 *   cut, further inputs queue durably, nothing processes
 * - `POST /api/chats/:id/resume`     — pick the work back up (a round
 *   runs over the backlog as it stands)
 */
export const ChannelsApi = Effect.gen(function* () {
  const sessions = yield* AI.Sessions;

  const channels = [
    { name: "root", chat: `Head:${ROOT}` },
    {
      name: "product",
      chat: `${PRODUCT_ADDRESS.term}:${PRODUCT_ADDRESS.key}`,
    },
    {
      name: "engineering",
      chat: `${MANAGER_ADDRESS.term}:${MANAGER_ADDRESS.key}`,
    },
  ];

  const parse = (id: string) => {
    const at = id.indexOf(":");
    return at === -1
      ? undefined
      : { term: id.slice(0, at), key: id.slice(at + 1) };
  };

  const control = (verb: "stop" | "resume") =>
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const session = parse(String(params.id ?? ""));
      if (session === undefined) {
        return yield* HttpServerResponse.json(
          { error: "bad session id" },
          { status: 400 },
        );
      }
      // STOP must actually stop: interrupt cuts the round in flight
      // (running tool cards end as aborted), then stop parks the
      // session so queued messages open nothing until resume
      yield* inWorker(
        verb === "stop"
          ? Effect.andThen(
              sessions.interrupt(session.term, session.key),
              sessions.stop(session.term, session.key),
            )
          : sessions.resume(session.term, session.key),
      );
      return yield* HttpServerResponse.json({ ok: true });
    });

  return Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/api/channels",
      HttpServerResponse.json({ channels }),
    ),
    HttpRouter.add("POST", "/api/chats/:id/stop", control("stop")),
    HttpRouter.add("POST", "/api/chats/:id/resume", control("resume")),
  );
});
