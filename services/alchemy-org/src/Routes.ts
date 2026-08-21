import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
 * {@link AI.Sessions} (the driver's outside window); each
 * transcript comes from the session's OWN storage
 * (`ThreadStorage.observations` shaped by `AI.toUIMessages`); the
 * live tail rides the session socket (`/attach`, wired by the
 * entrypoint). The BOARD is the review pipeline's projection: one
 * ReviewBot session per pull request, joined with GitHub's open-PR
 * list.
 */
export const routes = Effect.gen(function* () {
  const sessions = yield* AI.Sessions;
  // OPTIONAL: the local server reads transcripts straight from the
  // shared storage; on Cloudflare each session's rows live in its own
  // Durable Object — no worker-side ThreadStorage exists, snapshot
  // endpoints 404, and the UI hydrates from the session socket's
  // replay instead.
  const storage = yield* Effect.serviceOption(AI.ThreadStorage);
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
    const [summaries, openPrs] = yield* Effect.all(
      [
        sessions.list(),
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
    return buildBoard(repoName, summaries, openPrs);
  });

  const listSessions = HttpRouter.add(
    "GET",
    "/api/chats",
    Effect.gen(function* () {
      return yield* HttpServerResponse.json(yield* sessions.list());
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
      if (Option.isNone(storage)) {
        return yield* HttpServerResponse.json(
          { error: "transcripts ride the session socket on this placement" },
          { status: 404 },
        );
      }
      const params = yield* HttpRouter.params;
      const { term, key } = parseSessionId(
        decodeURIComponent(String(params.id ?? "")),
      );
      // an unknown session is an EMPTY one — the chat exists from the
      // first visit, before any message has been sent
      const handle = yield* storage.value.open(term, key);
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
      if (Option.isNone(storage)) {
        return yield* HttpServerResponse.json(
          { error: "transcripts ride the session socket on this placement" },
          { status: 404 },
        );
      }
      const request = yield* HttpServerRequest;
      const params = yield* HttpRouter.params;
      const { term, key } = parseSessionId(
        decodeURIComponent(String(params.id ?? "")),
      );
      const handle = yield* storage.value.open(term, key);
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

  /** The operator's off switch: settle a session in place. Terminal
   *  and idempotent; the transcript stays readable. */
  const stopSession = HttpRouter.add(
    "POST",
    "/api/chats/:id/stop",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const id = decodeURIComponent(String(params.id ?? ""));
      const { term, key } = parseSessionId(id);
      yield* sessions
        .stop(term, key)
        .pipe(Effect.provide(RuntimeContext.phantom));
      return yield* HttpServerResponse.json({ stopped: id });
    }),
  );

  /** The operator's eraser: stop the session, purge its transcript,
   *  drop it from the directory. Idempotent. */
  const removeSession = HttpRouter.add(
    "DELETE",
    "/api/chats/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const id = decodeURIComponent(String(params.id ?? ""));
      const { term, key } = parseSessionId(id);
      yield* sessions
        .remove(term, key)
        .pipe(Effect.provide(RuntimeContext.phantom));
      return yield* HttpServerResponse.json({ removed: id });
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
    stopSession,
    removeSession,
    requestReview,
    approvalsPending,
    approvalsAnswer,
    status,
  );
});
