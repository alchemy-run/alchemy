/**
 * The bot's HTTP surface: the board (pull requests + their review
 * threads), chat transcripts in the AI SDK UIMessage protocol, and
 * the raw observation log for debugging. `orgRoutes` resolves its
 * services from the entrypoint's composition and returns the router
 * layer; the entrypoint adds the run-socket `/attach` door and
 * serves.
 */
import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { buildBoard } from "./lib/Board.ts";
import { testAlchemy } from "./Repos.ts";
import { ReviewBot } from "./ReviewBot.ts";

export const orgRoutes = Effect.gen(function* () {
  const chats = yield* AI.Chats;
  const bot = yield* ReviewBot;
  const listPullRequests = yield* GitHub.ListPullRequests(testAlchemy);
  const getPullRequest = yield* GitHub.GetPullRequest(testAlchemy);

  const sseHeaders = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
  const encoder = new TextEncoder();

  const identity = yield* GitHub.resolveRepository(testAlchemy);
  const repoName = `${identity.owner}/${identity.repository}`;

  const readBoard = Effect.gen(function* () {
    const [chatList, openPrs] = yield* Effect.all(
      [
        chats.list(),
        listPullRequests({ state: "open" }).pipe(
          Effect.map((list) =>
            list.map((pull) => ({ number: pull.number, title: pull.title })),
          ),
          // GitHub down ≠ board down: states degrade to "unknown"
          Effect.catch(() => Effect.succeed(undefined)),
        ),
      ] as const,
      { concurrency: 2 },
    );
    return buildBoard(repoName, chatList, openPrs);
  });

  const listChats = HttpRouter.add(
    "GET",
    "/api/chats",
    Effect.gen(function* () {
      return yield* HttpServerResponse.json(yield* chats.list());
    }),
  );

  const board = HttpRouter.add(
    "GET",
    "/api/board",
    Effect.gen(function* () {
      return yield* HttpServerResponse.json(yield* readBoard);
    }),
  );

  /** Directory feed: SSE snapshots of the board as threads change. */
  const boardStream = HttpRouter.add(
    "GET",
    "/api/board/stream",
    Effect.gen(function* () {
      let previous = "";
      const stream = Stream.fromEffectSchedule(
        readBoard,
        Schedule.spaced("1 second"),
      ).pipe(
        Stream.map((next) => {
          const payload = JSON.stringify(next);
          if (payload === previous) return undefined;
          previous = payload;
          return `data: ${payload}\n\n`;
        }),
        Stream.filter((line): line is string => line !== undefined),
        Stream.interruptWhen(Effect.sleep("30 minutes")),
        Stream.map((line) => encoder.encode(line)),
        Stream.catch(() => Stream.empty),
      ) as Stream.Stream<Uint8Array>;
      return HttpServerResponse.stream(stream, { headers: sseHeaders });
    }),
  );

  const chatMessages = HttpRouter.add(
    "GET",
    "/api/chats/:id/messages",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const id = decodeURIComponent(String(params.id ?? ""));
      // snapshot is kernel vocabulary; the AI SDK shaping is the
      // adapter's (`AI.toUIMessages`)
      const snapshot = yield* chats.snapshot(id);
      return snapshot === undefined
        ? yield* HttpServerResponse.json(
            { error: `unknown chat: ${id}` },
            { status: 404 },
          )
        : yield* HttpServerResponse.json(
            AI.toUIMessages(snapshot.log, snapshot.streaming),
          );
    }),
  );

  // the RAW observation log — kernel vocabulary, crashes included.
  // The debugging poll: `messages` shapes for the UI, this tells the
  // truth (`?limit=N` tails the last N observations).
  const chatLog = HttpRouter.add(
    "GET",
    "/api/chats/:id/log",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const params = yield* HttpRouter.params;
      const id = decodeURIComponent(String(params.id ?? ""));
      const snapshot = yield* chats.snapshot(id);
      if (snapshot === undefined) {
        return yield* HttpServerResponse.json(
          { error: `unknown chat: ${id}` },
          { status: 404 },
        );
      }
      const limitRaw = new URL(request.url, "http://org").searchParams.get(
        "limit",
      );
      const limit = limitRaw === null ? undefined : Number(limitRaw);
      const log =
        limit !== undefined && Number.isFinite(limit) && limit > 0
          ? snapshot.log.slice(-limit)
          : snapshot.log;
      return yield* HttpServerResponse.json({
        log,
        streaming: snapshot.streaming,
      });
    }),
  );

  /**
   * The operator's door: REQUEST a review for a PR with no live
   * thread — a fresh process (the in-memory kernel forgets on
   * restart), or a PR whose events predate this deploy. The server
   * synthesizes the same `PullRequestOpened` shape the wire delivers
   * and sends it to the bot; the thread appears on the board stream.
   */
  const requestReview = HttpRouter.add(
    "POST",
    "/api/prs/:number/review",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const number = Number(params.number);
      if (!Number.isFinite(number)) {
        return yield* HttpServerResponse.json(
          { error: "bad pull request number" },
          { status: 400 },
        );
      }
      const pull = yield* getPullRequest({ pull_number: number }).pipe(
        Effect.catch((error) =>
          Effect.succeed({ error: `${error.operation}: ${error.message}` }),
        ),
      );
      if ("error" in pull) {
        return yield* HttpServerResponse.json(pull, { status: 404 });
      }
      yield* bot
        .send(
          {
            _tag: "PullRequestOpened",
            repository: {
              name: identity.repository,
              owner: { login: identity.owner },
            },
            pullRequest: {
              number: pull.number,
              title: pull.title,
              body: pull.body,
              merged: false,
            },
          },
          { key: `${identity.owner}/${identity.repository}#${number}` },
        )
        .pipe(Effect.provide(RuntimeContext.phantom));
      return yield* HttpServerResponse.json({ requested: number });
    }),
  );

  const status = HttpRouter.add(
    "GET",
    "/api/status",
    Effect.gen(function* () {
      const snapshot = yield* listPullRequests({ state: "open" }).pipe(
        Effect.map((list) => ({
          phase: "running",
          openPullRequests: list.map((pull) => ({
            number: pull.number,
            title: pull.title,
          })),
        })),
        Effect.catch((error) =>
          Effect.succeed({ phase: "degraded", error: String(error) } as const),
        ),
      );
      return yield* HttpServerResponse.json(snapshot);
    }),
  );

  return Layer.mergeAll(
    listChats,
    board,
    boardStream,
    chatMessages,
    chatLog,
    requestReview,
    status,
  );
});
