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
import { Approvals } from "./services/Approvals.ts";

/** `${term}:${key}` → the session it names (the key may contain `:`). */
const parseSessionId = (id: string): { term: string; key: string } => {
  const at = id.indexOf(":");
  return at < 0
    ? { term: id, key: id }
    : { term: id.slice(0, at), key: id.slice(at + 1) };
};

/**
 * The org's HTTP surface. The chat list comes from the
 * {@link AI.SessionIndex} (the one cross-session aggregate); each
 * transcript comes from the session's OWN storage
 * (`ThreadStorage.observations` shaped by `AI.toUIMessages`); the
 * live tail rides the session socket (`/attach`, wired by the
 * entrypoint). The BOARD is the review pipeline's projection: one
 * ReviewBot session per pull request, joined with GitHub's open-PR
 * list.
 */
export const orgRoutes = Effect.gen(function* () {
  const index = yield* AI.SessionIndex;
  const storage = yield* AI.ThreadStorage;
  const bot = yield* ReviewBot;
  const approvals = yield* Approvals;
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
    const [sessions, openPrs] = yield* Effect.all(
      [
        index.list(),
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
    return buildBoard(repoName, sessions, openPrs);
  });

  const listSessions = HttpRouter.add(
    "GET",
    "/api/chats",
    Effect.gen(function* () {
      return yield* HttpServerResponse.json(yield* index.list());
    }),
  );

  const board = HttpRouter.add(
    "GET",
    "/api/board",
    Effect.gen(function* () {
      return yield* HttpServerResponse.json(yield* readBoard);
    }),
  );

  /** Directory feed: SSE snapshots of the board as sessions change. */
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

  const sessionMessages = HttpRouter.add(
    "GET",
    "/api/chats/:id/messages",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const { term, key } = parseSessionId(
        decodeURIComponent(String(params.id ?? "")),
      );
      // an unknown session is an EMPTY one — the chat exists from the
      // first visit, before any message has been sent
      const handle = yield* storage.open(term, key);
      const log = yield* handle.observations(0);
      return yield* HttpServerResponse.json(AI.toUIMessages(log));
    }),
  );

  // the RAW observation log — driver vocabulary, crashes included.
  // The debugging poll: `messages` shapes for the UI, this tells the
  // truth (`?limit=N` tails the last N observations).
  const sessionLog = HttpRouter.add(
    "GET",
    "/api/chats/:id/log",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const params = yield* HttpRouter.params;
      const { term, key } = parseSessionId(
        decodeURIComponent(String(params.id ?? "")),
      );
      const handle = yield* storage.open(term, key);
      const log = yield* handle.observations(0);
      const limitRaw = new URL(request.url, "http://org").searchParams.get(
        "limit",
      );
      const limit = limitRaw === null ? undefined : Number(limitRaw);
      return yield* HttpServerResponse.json({
        log:
          limit !== undefined && Number.isFinite(limit) && limit > 0
            ? log.slice(-limit)
            : log,
      });
    }),
  );

  /**
   * The operator's door: REQUEST a review for a PR with no session on
   * the board — a PR whose events predate this deploy, or one the
   * poller missed. The server synthesizes the same `PullRequestOpened`
   * shape the wire delivers and sends it to the bot; the session
   * appears on the board stream.
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

  /** The operator's gate: pending approval requests + the answer door. */
  const approvalsPending = HttpRouter.add(
    "GET",
    "/api/approvals",
    Effect.gen(function* () {
      return yield* HttpServerResponse.json(yield* approvals.pending());
    }),
  );

  const approvalsAnswer = HttpRouter.add(
    "POST",
    "/api/approvals/:id",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const params = yield* HttpRouter.params;
      const id = String(params.id ?? "");
      const body = (yield* request.json.pipe(
        Effect.catch(() => Effect.succeed({})),
      )) as { outcome?: string };
      const outcome =
        body.outcome === "allowed-once" || body.outcome === "rejected"
          ? body.outcome
          : undefined;
      if (outcome === undefined) {
        return yield* HttpServerResponse.json(
          { error: "outcome must be 'allowed-once' or 'rejected'" },
          { status: 400 },
        );
      }
      const answered = yield* approvals.answer(id, outcome);
      // an unknown id is fine: answered elsewhere or expired — the
      // world outranks the click
      return yield* HttpServerResponse.json({ answered });
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
    listSessions,
    board,
    boardStream,
    sessionMessages,
    sessionLog,
    requestReview,
    approvalsPending,
    approvalsAnswer,
    status,
  );
});
