import * as AI from "alchemy/AI";
import * as Cloudflare from "alchemy/Cloudflare";
import * as TypeSafe from "alchemy/TypeSafe";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { MANAGER_ADDRESS } from "../engineering/Triage.ts";
import { inWorker } from "../platform/Database.ts";
import { lineage, nameOfKey, ROOT } from "../Lineage.ts";
import { mentionsOf } from "./Ask.ts";
import { judge } from "./Gate.ts";
import { Posts } from "./Posts.ts";

/**
 * The CHANNELS — one per `AI.Group`, because every group has a channel
 * at its core: the session of its HEAD. `#root` is the Root Group's
 * (the Head's session — the humans' conversation with the company);
 * `#engineering` is the Engineering group's (the manager's session —
 * where GitHub events arrive as messages and get worked one by one).
 * A new group in code is a new channel here.
 *
 * - `GET  /api/channels`                  — the list (name + chat id)
 * - `POST /api/channels/:name/messages`   — the human posts: the
 *   message lands as a POST (a new thread root, or INTO a thread when
 *   the body carries `replyTo`), the agent is dispatched with the
 *   post's id as the message id, and what the agent says back lands
 *   as its reply post
 * - `POST /api/chats/:id/stop`       — park the channel: the round is
 *   cut, further inputs queue durably, nothing processes
 * - `POST /api/chats/:id/resume`     — pick the work back up (a round
 *   runs over the backlog as it stands)
 */
export const ChannelsApi = Effect.gen(function* () {
  const sessions = yield* AI.Sessions;
  const posts = yield* Posts;
  const exec = yield* Cloudflare.WorkerExecutionContext;

  const channels = [
    { name: "root", chat: `Head:${ROOT}` },
    {
      name: "engineering",
      chat: `${MANAGER_ADDRESS.term}:${MANAGER_ADDRESS.key}`,
    },
    // DMs — the human's private line to ONE agent. The left rail's
    // agent rows open these; the resident answers, no @mention
    // needed. Same machinery as a channel: a DM is a channel whose
    // room is one agent.
    { name: "head", chat: `Head:${ROOT}`, dm: true },
    {
      name: "manager",
      chat: `${MANAGER_ADDRESS.term}:${MANAGER_ADDRESS.key}`,
      dm: true,
    },
    { name: "engineer", chat: `Engineer:${lineage("engineer")}`, dm: true },
    { name: "reviewer", chat: `Reviewer:${lineage("reviewer")}`, dm: true },
  ];

  /** The channel agent's session FOR one message — every response is
   *  prepared in its own space (`…::<post-id>`), so no session
   *  accumulates the channel's history. */
  const invocationKey = (standing: string, post: string) =>
    standing === ROOT ? `${ROOT}::head::${post}` : `${standing}::${post}`;

  const parse = (id: string) => {
    const at = id.indexOf(":");
    return at === -1
      ? undefined
      : { term: id.slice(0, at), key: id.slice(at + 1) };
  };

  /** The human's identity, until auth exists (mirrors the UI). */
  const HUMAN = "sam";

  /** The gate's reflex judgment, resolved once (see Gate.ts). */
  const query = yield* TypeSafe.SystemOne;

  /** Who a judged respondent IS — the DM rows are their addresses. */
  const addressOf = (name: string) =>
    channels.find(
      (candidate) => candidate.dm === true && candidate.name === name,
    )?.chat;

  const ROSTER = channels
    .filter((candidate) => candidate.dm === true)
    .map((candidate) => candidate.name);

  const send = Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const channel = channels.find(
      (candidate) => candidate.name === String(params.name ?? ""),
    );
    if (channel === undefined) {
      return yield* HttpServerResponse.json(
        { error: "no such channel" },
        { status: 404 },
      );
    }
    const request = yield* HttpServerRequest;
    const body = (yield* request.json.pipe(
      Effect.catch(() => Effect.succeed({})),
    )) as { text?: string; replyTo?: string };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text.length === 0) {
      return yield* HttpServerResponse.json(
        { error: "text required" },
        { status: 400 },
      );
    }
    // a message INTO a thread references what it answers — the
    // referenced message must exist (the thread's root or any row)
    const replyTo =
      typeof body.replyTo === "string" && body.replyTo.length > 0
        ? body.replyTo
        : undefined;
    if (replyTo !== undefined && (yield* posts.get(replyTo)) === undefined) {
      return yield* HttpServerResponse.json(
        { error: "no such message to reply to" },
        { status: 404 },
      );
    }

    const minted = yield* Clock.currentTimeMillis;
    const postId = `p-${minted.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    // THE GATE (Gate.ts): a message on a channel is judged before
    // anyone wakes up — is it worth nothing, a reply in the stream, or
    // a thread, and who answers? A DM is already addressed to someone,
    // a reply is already in its thread, and an @mention is the human
    // routing by hand; all three skip the judgment. So does a verdict
    // the gate isn't sure of — then the resident answers in a thread,
    // exactly as before.
    const judged =
      channel.dm === true ||
      replyTo !== undefined ||
      mentionsOf(text).length > 0
        ? undefined
        : yield* judge(query, {
            channel: channel.name,
            message: text,
            roster: ROSTER,
          });

    // an ignored message still LANDS — it is part of the conversation,
    // it just settles on arrival with nobody dispatched
    if (judged?.disposition === "ignore") {
      yield* posts.post({
        id: postId,
        ...(replyTo !== undefined ? { replyTo } : {}),
        channel: channel.name,
        author: HUMAN,
        text,
        status: "settled",
      });
      return yield* HttpServerResponse.json(
        { post: postId, disposition: "ignore" },
        { status: 202 },
      );
    }

    // an INLINE answer is a message in the channel, not a thread under
    // the human's message: it lands as its own post with no `replyTo`
    const inline = judged?.disposition === "inline";
    const target = parse(
      (judged !== undefined ? addressOf(judged.respondent) : undefined) ??
        channel.chat,
    )!;
    const agent = nameOfKey(target.key);

    // the message IS a post, `running` until the exchange resolves —
    // that status is the ONE pending indicator (no placeholder rows),
    // and `answering` names who it waits on, so the channel reads
    // "engineer is typing…" rather than showing an anonymous spinner
    yield* posts.post({
      id: postId,
      ...(replyTo !== undefined ? { replyTo } : {}),
      channel: channel.name,
      author: HUMAN,
      text,
      answering: agent,
    });

    // dispatch rides the post's id (idempotent delivery; the agent's
    // `Thread.invocations` sees the post it is answering). Only what
    // the agent SAID becomes a reply post: a text answer lands as the
    // agent's reply; a termination outcome (a stop, an abort, a
    // crash) is an execution fact — the root settles `failed` and the
    // why lives in the agent's transcript, never as a fake message
    const clip = (value: string) =>
      value.length > 8_000 ? `${value.slice(0, 8_000)}\n[… clipped]` : value;
    const session = invocationKey(target.key, postId);
    yield* exec.waitUntil(
      sessions
        .dispatch(target.term, session, {
          id: postId,
          author: HUMAN,
          content: text,
        })
        .pipe(
          Effect.flatMap((outcome) => {
            const answer = typeof outcome === "string" ? outcome.trim() : "";
            if (answer.length > 0) {
              return Effect.andThen(
                posts.post({
                  id: `${postId}-${agent}`,
                  ...(inline ? {} : { replyTo: postId }),
                  channel: channel.name,
                  author: agent,
                  text: clip(answer),
                  status: "settled",
                }),
                posts.settle(postId, "settled"),
              );
            }
            return posts.settle(
              postId,
              typeof outcome === "string" ? "settled" : "failed",
            );
          }),
          Effect.catchCause(() => posts.settle(postId, "failed")),
        ),
    );
    return yield* HttpServerResponse.json({ post: postId }, { status: 202 });
  });

  /** name → session term, for cutting a running ask's workers. */
  const TERMS: Record<string, string> = {
    head: "Head",
    manager: MANAGER_ADDRESS.term,
    engineer: "Engineer",
    reviewer: "Reviewer",
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
      const cut = (term: string, key: string) =>
        Effect.andThen(sessions.interrupt(term, key), sessions.stop(term, key));
      // a CHANNEL's stop cuts everything in flight — every running
      // message runs in its OWN invocation session, so walk the
      // channel's running posts: the humans' (the channel agent's
      // sessions) and the asks' (the mentioned workers' sessions)
      const channelHere = channels.find(
        (candidate) => candidate.chat === `${session.term}:${session.key}`,
      );
      if (verb === "stop" && channelHere !== undefined) {
        const stream = yield* posts.list({ channel: channelHere.name });
        const running = stream.filter((post) => post.status === "running");
        yield* inWorker(
          Effect.forEach(
            running,
            (post) =>
              post.author === HUMAN
                ? cut(session.term, invocationKey(session.key, post.id))
                : Effect.forEach(
                    mentionsOf(post.text),
                    (name) => {
                      const term = TERMS[name];
                      return term === undefined
                        ? Effect.void
                        : cut(term, `${ROOT}::${name}::${post.id}`);
                    },
                    { discard: true },
                  ),
            { discard: true },
          ).pipe(Effect.ignore),
        );
      }
      // …and the standing session as before (notes, legacy rounds)
      yield* inWorker(
        verb === "stop"
          ? cut(session.term, session.key)
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
    HttpRouter.add("POST", "/api/channels/:name/messages", send),
    HttpRouter.add("POST", "/api/chats/:id/stop", control("stop")),
    HttpRouter.add("POST", "/api/chats/:id/resume", control("resume")),
  );
});
