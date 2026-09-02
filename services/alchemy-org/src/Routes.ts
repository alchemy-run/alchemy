import * as AI from "alchemy/AI";
import * as Git from "alchemy/Git";
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
import {
  buildPullRequestView,
  pullRequestRef,
  pullSessionKey,
  type PullRequestView,
} from "./lib/PullRequest.ts";
import { connected, testAlchemy } from "./Repos.ts";
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
 * A PHANTOM thread identity — just enough `AI.Thread` for the sandbox
 * layer to derive the session's machine (it only reads `key`). Lets
 * the WORKER-level terminal door address a session's MicroVM without
 * being inside the session: the sandbox keys machines by
 * `machineKey(thread.key)`, so providing the session key here lands
 * on the same VM the session's threads use.
 */
const phantomThread = (key: string): AI.ThreadService => ({
  key,
  tokens: Effect.succeed(0),
  entries: Effect.succeed([]),
  compact: () => Effect.void,
  reply: () => Effect.void,
  remind: () => Effect.void,
});

/**
 * The org's HTTP surface. The chat list comes from the
 * {@link AI.Sessions} (the driver's outside window); each
 * transcript is the session's durable log (`Sessions.history`, read
 * from wherever the placement keeps it, shaped by `AI.toUIMessages`);
 * the live tail rides the session socket (`/attach`, wired by the
 * entrypoint). The BOARD is the review pipeline's projection: one
 * ReviewBot session per pull request, joined with GitHub's open-PR
 * list.
 */
export const routes = Effect.gen(function* () {
  const sessions = yield* AI.Sessions;
  // OPTIONAL: the terminal door needs the session machine seam; a
  // placement without a sandbox (pure API mirror) 404s the route.
  const sandbox = yield* Effect.serviceOption(AI.Sandbox);
  // OPTIONAL: git over that same machine — the pull-request checkout
  // door converges a PR machine's tree from the Worker level (the same
  // `SandboxSession` composition the charters use provides it).
  const checkouts = yield* Effect.serviceOption(Git.Checkouts);
  // OPTIONAL: the review pipeline may be dropped from the stack (it is
  // right now — see Worker.ts) — the request-review door answers 503
  // instead of failing the whole router build.
  const bot = yield* Effect.serviceOption(ReviewBot);
  const approvals = yield* Approvals;
  const listPullRequests = yield* GitHub.ListPullRequests(testAlchemy);
  const getPullRequest = yield* GitHub.GetPullRequest(testAlchemy);
  const listIssueComments = yield* GitHub.ListIssueComments(testAlchemy);
  const listReviews = yield* GitHub.ListPullRequestReviews(testAlchemy);
  const listReviewComments =
    yield* GitHub.ListPullRequestReviewComments(testAlchemy);

  // the CONNECTED repositories — static code (Repos.ts), reflected
  // read-only; identities resolve without provisioning
  const repos = yield* Effect.forEach(connected, (entry) =>
    GitHub.resolveRepository(entry.repository).pipe(
      Effect.map((identity) => ({
        name: `${identity.owner}/${identity.repository}`,
        sessions: entry.sessions,
        reviews: entry.reviews,
      })),
    ),
  );

  const sseHeaders = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
  const encoder = new TextEncoder();

  const identity = yield* GitHub.resolveRepository(testAlchemy);
  const repoName = `${identity.owner}/${identity.repository}`;

  // GitHub's PR list rides ONE isolate-wide TTL cache: the board SSE
  // stream ticks once per second PER CLIENT, and every tick hitting
  // GitHub live blew through the secondary rate limit (403 storms)
  // with a handful of open tabs. Session rows stay tick-fresh — only
  // the GitHub half is capped.
  //
  // Hand-rolled over PLAIN DATA on purpose: `Effect.cachedWithTTL`
  // shares the in-flight computation across callers via a Latch, and
  // workerd pins promises to their creating request's IoContext — a
  // second request awaiting the first request's fetch gets its
  // continuation CANCELED when the creator completes ("promise was
  // resolved from a different request context"), hanging the request
  // until the runtime kills it. Caching the resolved value is safe;
  // sharing the promise is not. A stale window may pay a few
  // concurrent fetches — fine at this TTL.
  type OpenPulls = ReadonlyArray<{ number: number; title: string }> | undefined;
  let openPullsCache: { at: number; value: OpenPulls } | undefined;
  const openPullsCached = Effect.gen(function* () {
    const now = Date.now();
    if (openPullsCache !== undefined && now - openPullsCache.at < 15_000) {
      return openPullsCache.value;
    }
    const value: OpenPulls = yield* listPullRequests({ state: "open" }).pipe(
      Effect.map((list) =>
        list.map((pull) => ({ number: pull.number, title: pull.title })),
      ),
      // GitHub down ≠ board down: states degrade to "unknown"
      Effect.catch(() => Effect.succeed(undefined)),
    );
    openPullsCache = { at: now, value };
    return value;
  });

  const readBoard = Effect.gen(function* () {
    const [summaries, openPrs] = yield* Effect.all(
      [sessions.list(), openPullsCached] as const,
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

  /** The connected repositories — a read-only reflection of code. */
  const listRepos = HttpRouter.add(
    "GET",
    "/api/repos",
    Effect.gen(function* () {
      return yield* HttpServerResponse.json(repos);
    }),
  );

  /**
   * The TERMINAL door: run one command on a session's machine — the
   * same MicroVM its threads work on (the sandbox layer keys machines
   * by session, so a phantom thread with the session key lands there).
   * REPL-grade (collected output), not a PTY: the UI sends a line,
   * renders the result, repeats.
   */
  const sessionExec = HttpRouter.add(
    "POST",
    "/api/sessions/:id/exec",
    Effect.gen(function* () {
      if (Option.isNone(sandbox)) {
        return yield* HttpServerResponse.json(
          { error: "no session sandbox on this placement" },
          { status: 404 },
        );
      }
      const request = yield* HttpServerRequest;
      const params = yield* HttpRouter.params;
      const { key } = parseSessionId(
        decodeURIComponent(String(params.id ?? "")),
      );
      const body = (yield* request.json.pipe(
        Effect.catch(() => Effect.succeed({})),
      )) as { command?: string; cwd?: string };
      const command =
        typeof body.command === "string" ? body.command.trim() : "";
      if (command.length === 0) {
        return yield* HttpServerResponse.json(
          { error: "command required" },
          { status: 400 },
        );
      }
      const result = yield* sandbox.value
        .exec(command, undefined, {
          timeout: 120_000,
          ...(typeof body.cwd === "string" ? { cwd: body.cwd } : {}),
        })
        .pipe(
          Effect.provideService(AI.Thread, phantomThread(key)),
          // sandbox failures are model-visible strings — surface them
          // as a failed exec, not a 500
          Effect.catch((error) =>
            Effect.succeed({
              success: false,
              exitCode: -1,
              stdout: "",
              stderr: String(error),
              stdoutTruncated: false,
              stderrTruncated: false,
              durationMs: 0,
            }),
          ),
        );
      return yield* HttpServerResponse.json(result);
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
      const log = yield* sessions
        .history(term, key)
        .pipe(Effect.provide(RuntimeContext.phantom));
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
      const log = yield* sessions
        .history(term, key)
        .pipe(Effect.provide(RuntimeContext.phantom));
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

  /** The operator's "new session/thread": admit the key durably so it
   *  LISTS at once — for every client, across reloads — before any
   *  input. Its machine boots and its checkout converges on the first
   *  input (or terminal), exactly as before. Idempotent. */
  const openSession = HttpRouter.add(
    "POST",
    "/api/chats/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const id = decodeURIComponent(String(params.id ?? ""));
      const { term, key } = parseSessionId(id);
      yield* sessions
        .open(term, key)
        .pipe(Effect.provide(RuntimeContext.phantom));
      return yield* HttpServerResponse.json({ opened: id }, { status: 201 });
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

  /** The operator's undo for stop: reopen a settled session in place —
   *  the transcript continues where it left off. Idempotent. */
  const resumeSession = HttpRouter.add(
    "POST",
    "/api/chats/:id/resume",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const id = decodeURIComponent(String(params.id ?? ""));
      const { term, key } = parseSessionId(id);
      yield* sessions
        .resume(term, key)
        .pipe(Effect.provide(RuntimeContext.phantom));
      return yield* HttpServerResponse.json({ resumed: id });
    }),
  );

  /** The operator's eraser: stop the session, purge its transcript,
   *  drop it from the directory. Idempotent. The MACHINE dies with the
   *  last thread of its group — no thread is special: deleting any
   *  thread while siblings remain leaves their shared machine alone;
   *  the one that empties the group carries the teardown. */
  const removeSession = HttpRouter.add(
    "DELETE",
    "/api/chats/:id",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const id = decodeURIComponent(String(params.id ?? ""));
      const { term, key } = parseSessionId(id);
      // thread keys are `<session>` or `<session>::<thread>` — the
      // session part names the machine (Worker.ts's machineKey)
      const machineOf = (threadKey: string): string => {
        const at = threadKey.indexOf("::");
        return at < 0 ? threadKey : threadKey.slice(0, at);
      };
      const rows = yield* sessions.list();
      const siblings = rows.filter(
        (row) =>
          row.term === term &&
          row.key !== key &&
          machineOf(row.key) === machineOf(key),
      );
      yield* sessions
        .remove(term, key, { machine: siblings.length === 0 })
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
      if (Option.isNone(bot)) {
        return yield* HttpServerResponse.json(
          { error: "the review pipeline is disabled on this placement" },
          { status: 503 },
        );
      }
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
      yield* bot.value
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

  /** `:number` → the PR number, or a 400 response. */
  const pullNumber = Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const number = Number(params.number);
    return Number.isFinite(number) && number > 0 ? number : undefined;
  });

  // The PR PAGE rides the same plain-data TTL cache as the board's
  // open-PR list (and for the same reason — see `openPullsCached`):
  // one operator staring at a PR polls it, and four GitHub reads per
  // poll must not burn the rate limit. Per PR, short-lived.
  const pullViewCache = new Map<
    number,
    { at: number; value: PullRequestView }
  >();
  const readPullRequestView = (number: number) =>
    Effect.gen(function* () {
      const now = Date.now();
      const cached = pullViewCache.get(number);
      if (cached !== undefined && now - cached.at < 10_000) {
        return cached.value;
      }
      const [pull, comments, reviews, inline] = yield* Effect.all(
        [
          getPullRequest({ pull_number: number }),
          listIssueComments({ issue_number: number, per_page: 100 }),
          listReviews({ pull_number: number, per_page: 100 }),
          listReviewComments({ pull_number: number, per_page: 100 }),
        ] as const,
        { concurrency: 4 },
      );
      const value = buildPullRequestView(
        repoName,
        pull,
        comments,
        reviews,
        inline,
      );
      pullViewCache.set(number, { at: now, value });
      return value;
    });

  /**
   * The PULL REQUEST page: the PR (title, body, branches, size) joined
   * with its whole conversation — issue comments, reviews with their
   * verdicts, and the inline comments each review carried — as ONE
   * timeline, oldest first. The operator reads the PR here beside the
   * threads and terminals working on it.
   */
  const pullRequest = HttpRouter.add(
    "GET",
    "/api/prs/:number",
    Effect.gen(function* () {
      const number = yield* pullNumber;
      if (number === undefined) {
        return yield* HttpServerResponse.json(
          { error: "bad pull request number" },
          { status: 400 },
        );
      }
      const view = yield* readPullRequestView(number).pipe(
        Effect.catch((error) =>
          Effect.succeed({ error: `${error.operation}: ${error.message}` }),
        ),
      );
      if ("error" in view) {
        return yield* HttpServerResponse.json(view, { status: 404 });
      }
      return yield* HttpServerResponse.json(view);
    }),
  );

  /**
   * The PR machine's CHECKOUT door: converge the tree on the machine
   * every session of this PR shares (`owner/repo#N` — the machine key)
   * onto the PR's head as it is NOW. `fresh: true` re-fetches, so this
   * is the "resume and pull" act: the operator opening a thread or a
   * terminal on a PR calls it first, and the machine (launched or
   * woken by the call) lands on the PR branch before anyone types.
   * Idempotent; the charters' own INIT re-runs the same converge.
   */
  const pullRequestCheckout = HttpRouter.add(
    "POST",
    "/api/prs/:number/checkout",
    Effect.gen(function* () {
      if (Option.isNone(checkouts)) {
        return yield* HttpServerResponse.json(
          { error: "no session machines on this placement" },
          { status: 404 },
        );
      }
      const number = yield* pullNumber;
      if (number === undefined) {
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
      const key = pullSessionKey(repoName, number);
      const result = yield* checkouts.value
        .checkout({
          key,
          remote: GitHub.remote(testAlchemy),
          ref: pullRequestRef(pull),
          fresh: true,
        })
        .pipe(
          // the phantom thread with the SESSION key lands the checkout
          // on the PR's machine (the sandbox layer reads only `key`)
          Effect.provideService(AI.Thread, phantomThread(key)),
          Effect.map((checkout) => ({
            key,
            branch: checkout.branch,
            root: checkout.root,
            ref: pullRequestRef(pull),
            headSha: pull.head.sha,
          })),
          // git failures are the operator's to read — a failed
          // checkout, not a 500
          Effect.catch((error) =>
            Effect.succeed({ key, error: error.message }),
          ),
        );
      return yield* HttpServerResponse.json(result, {
        status: "error" in result ? 502 : 200,
      });
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
    listRepos,
    sessionExec,
    board,
    boardStream,
    sessionMessages,
    sessionLog,
    openSession,
    stopSession,
    resumeSession,
    removeSession,
    requestReview,
    pullRequest,
    pullRequestCheckout,
    approvalsPending,
    approvalsAnswer,
    status,
  );
});
