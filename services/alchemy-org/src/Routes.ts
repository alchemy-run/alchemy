import * as AI from "alchemy/AI";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Git from "alchemy/Git";
import * as GitHub from "alchemy/GitHub";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Channel, parseEntityRef } from "./channel/Channel.ts";
import { ChannelAgent, channelRunKey } from "./channel/ChannelAgent.ts";
import { PublishToken } from "./github/PublishToken.ts";
import {
  buildPullRequestFilesPage,
  buildPullRequestView,
  PULL_FILES_PAGE_SIZE,
  type PullRequestFilesPage,
  type PullRequestView,
} from "./github/PullRequest.ts";
import { connected, primary } from "./github/Repos.ts";
import { Engineer } from "./coding/Engineer.ts";
import { ThreadAgent } from "./thread/ThreadAgent.ts";
import { pullWorktreeKey, THREAD_TERM, Threads } from "./thread/Threads.ts";

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
 * the WORKER-level terminal door address a session's machine without
 * being inside the session.
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
 * The org's HTTP surface, CHANNEL-FIRST:
 *
 * - `/api/channel` — the one org-wide stream (GET pages by the cursor
 *   protocol; POST appends the operator's message and runs the channel
 *   agent pinned to it). The live tail rides the `/channel` WebSocket
 *   (Worker.ts routes the upgrade into the ChannelDO).
 * - `/api/threads/:id` — a thread's state snapshot; POST steers its
 *   agent; the conversation itself is the agent session
 *   (`/api/chats/Thread:t-…/messages` + the `/attach` socket).
 * - `/api/pulls/:owner/:repo/:n(/files)` — on-demand GitHub reads for
 *   the review view; nothing is mirrored.
 */
export const routes = Effect.gen(function* () {
  const sessions = yield* AI.Sessions;
  const channel = yield* Channel;
  const threads = yield* Threads;
  const engineerTerm = Engineer["~alchemy/Name"];
  const channelAgent = yield* ChannelAgent;
  const threadAgent = yield* ThreadAgent;
  // OPTIONAL: the terminal door needs the session machine seam, and
  // deleting a thread drops its pull requests' worktrees through git
  // over that same machine
  const sandbox = yield* Effect.serviceOption(AI.Sandbox);
  const checkouts = yield* Effect.serviceOption(Git.Checkouts);
  const exec = yield* Cloudflare.WorkerExecutionContext;
  const publishToken = yield* Effect.serviceOption(PublishToken);

  const listPullRequests = yield* GitHub.ListPullRequests(primary);
  const listIssues = yield* GitHub.ListIssues(primary);
  const getPullRequest = yield* GitHub.GetPullRequest(primary);
  const listIssueComments = yield* GitHub.ListIssueComments(primary);
  const listReviews = yield* GitHub.ListPullRequestReviews(primary);
  const listReviewComments =
    yield* GitHub.ListPullRequestReviewComments(primary);
  const listPullFiles = yield* GitHub.ListPullRequestFiles(primary);

  // the CONNECTED repositories — static code (Repos.ts)
  const repos = yield* Effect.forEach(connected, (entry) =>
    GitHub.resolveRepository(entry.repository).pipe(
      Effect.map((identity) => `${identity.owner}/${identity.repository}`),
    ),
  );
  const identity = yield* GitHub.resolveRepository(primary);
  const repoName = `${identity.owner}/${identity.repository}`;
  const repoInfo = {
    name: identity.repository,
    owner: { login: identity.owner },
  };

  /* ── the operator's identity (cached; also signs channel posts) ── */

  type Operator = {
    login: string;
    name: string | null;
    avatarUrl: string;
    url: string;
  } | null;
  let operatorCache: { at: number; value: Operator } | undefined;
  const readOperator: Effect.Effect<Operator> = Effect.gen(function* () {
    if (Option.isNone(publishToken)) return null;
    const now = Date.now();
    if (operatorCache !== undefined && now - operatorCache.at < 600_000) {
      return operatorCache.value;
    }
    const token = yield* publishToken.value;
    const value: Operator = yield* Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get("https://api.github.com/user", {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${Redacted.value(token)}`,
          "user-agent": "alchemy-org",
        },
      });
      const user = (yield* response.json) as {
        login: string;
        name: string | null;
        avatar_url: string;
        html_url: string;
      };
      return {
        login: user.login,
        name: user.name,
        avatarUrl: user.avatar_url,
        url: user.html_url,
      };
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.catch(() => Effect.succeed(null)),
    );
    operatorCache = { at: now, value };
    return value;
  });

  /* ── bootstrap: the channel's first touch backfills open work ──── */

  const bootstrap = Effect.gen(function* () {
    const claimed = yield* channel.claimBootstrap();
    if (!claimed) return;
    const [pulls, issues] = yield* Effect.all(
      [
        listPullRequests({ state: "open", per_page: 100 }).pipe(
          Effect.catch(() => Effect.succeed([])),
        ),
        listIssues({ state: "open", per_page: 100 }).pipe(
          Effect.catch(() => Effect.succeed([])),
        ),
      ] as const,
      { concurrency: 2 },
    );
    // one path for bootstrap and live: synthetic events through deliver
    yield* Effect.forEach(
      pulls,
      (pull) =>
        channel.deliver(
          new GitHub.PullRequestOpened({
            repository: repoInfo,
            sender: pull.user ?? undefined,
            pullRequest: {
              number: pull.number,
              title: pull.title,
              state: pull.state,
              html_url: pull.html_url,
              user: pull.user,
            },
          }),
        ),
      { discard: true },
    );
    yield* Effect.forEach(
      // GitHub's issues list includes pull requests — drop them
      issues.filter((issue) => issue.pull_request === undefined),
      (issue) =>
        channel.deliver(
          new GitHub.IssueOpened({
            repository: repoInfo,
            sender: issue.user ?? undefined,
            issue: {
              number: issue.number,
              title: issue.title,
              state: issue.state,
              html_url: issue.html_url,
              user: issue.user,
            },
          }),
        ),
      { discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("channel bootstrap failed", cause),
    ),
  );

  /* ── the channel ────────────────────────────────────────────────── */

  const channelPage = HttpRouter.add(
    "GET",
    "/api/channel",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const url = new URL(request.url, "http://worker");
      const after = Number(url.searchParams.get("after") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "200");
      const page = yield* channel.page({
        after: Number.isFinite(after) && after >= 0 ? after : 0,
        limit: Number.isFinite(limit) && limit > 0 ? limit : 200,
      });
      if (page.head === 0) {
        // an empty channel's first reader kicks the one-time backfill
        yield* exec.waitUntil(bootstrap);
      }
      return yield* HttpServerResponse.json(page);
    }),
  );

  const channelPost = HttpRouter.add(
    "POST",
    "/api/channel",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const body = (yield* request.json.pipe(
        Effect.catch(() => Effect.succeed({})),
      )) as { text?: string; replyTo?: unknown };
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (text.length === 0) {
        return yield* HttpServerResponse.json(
          { error: "text required" },
          { status: 400 },
        );
      }
      // an inline reply names the messages it answers; only ids that
      // exist are kept (a stale client can't pin a phantom)
      const replyIds = Array.isArray(body.replyTo)
        ? body.replyTo.filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          )
        : [];
      const originals =
        replyIds.length === 0 ? [] : yield* channel.read(replyIds);
      const operator = yield* readOperator;
      const message = yield* channel.append({
        kind: "user",
        ...(operator === null ? {} : { author: { login: operator.login } }),
        text,
        ...(originals.length === 0
          ? {}
          : { replyTo: originals.map((row) => row.id) }),
      });
      // the ONE trigger of the channel agent: a fresh session pinned
      // to this message's seq; the request answers immediately, the
      // run's reply lands in the channel when it lands. A reply hands
      // the agent the quoted originals — it reads what was answered
      // without having to search for it.
      const prompt =
        originals.length === 0
          ? text
          : `${originals
              .map(
                (row) =>
                  `> In reply to ${row.kind} message ${row.id}${
                    row.author === undefined ? "" : ` by ${row.author.login}`
                  }:\n${row.text
                    .split("\n")
                    .map((line) => `> ${line}`)
                    .join("\n")}`,
              )
              .join("\n\n")}\n\n${text}`;
      yield* exec.waitUntil(
        channelAgent.dispatch(prompt, { key: channelRunKey(message.seq) }).pipe(
          Effect.flatMap((outcome) =>
            Effect.gen(function* () {
              // The charter's `reply` tool is the intended door into
              // the channel; when the model ends the run with plain
              // text instead (dispatch resolves with the quiescent
              // text), land that text so the operator never faces
              // silence.
              const since = yield* channel.page({ after: message.seq });
              const replied = since.items.some((row) => row.kind === "agent");
              if (
                !replied &&
                typeof outcome === "string" &&
                outcome.trim().length > 0
              ) {
                yield* channel.append({ kind: "agent", text: outcome });
              }
            }),
          ),
        ),
      );
      return yield* HttpServerResponse.json(message);
    }),
  );

  /** The body of a bulk delete: `{ ids: string[] }`, empty when
   *  malformed. */
  const readIds = (request: HttpServerRequest) =>
    request.json.pipe(
      Effect.catch(() => Effect.succeed({})),
      Effect.map((body) => {
        const ids = (body as { ids?: unknown }).ids;
        return Array.isArray(ids)
          ? ids.filter(
              (id): id is string => typeof id === "string" && id.length > 0,
            )
          : [];
      }),
    );

  /** The operator pruning the log — delete rows by id (one or a
   *  selection). The DO broadcasts a `remove` frame so every open view
   *  drops them. */
  const channelMessagesDelete = HttpRouter.add(
    "DELETE",
    "/api/channel/messages",
    Effect.gen(function* () {
      const ids = yield* readIds(yield* HttpServerRequest);
      if (ids.length === 0) {
        return yield* HttpServerResponse.json(
          { error: "ids required" },
          { status: 400 },
        );
      }
      yield* channel.remove(ids);
      return yield* HttpServerResponse.json({ deleted: ids.length });
    }),
  );

  const channelDirectory = HttpRouter.add(
    "GET",
    "/api/channel/directory",
    Effect.gen(function* () {
      return yield* HttpServerResponse.json(yield* channel.directory());
    }),
  );

  /* ── threads ────────────────────────────────────────────────────── */

  const threadId = Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    return decodeURIComponent(String(params.id ?? ""));
  });

  const threadState = HttpRouter.add(
    "GET",
    "/api/threads/:id",
    Effect.gen(function* () {
      const id = yield* threadId;
      const state = yield* threads.get(id);
      return state === undefined
        ? yield* HttpServerResponse.json(
            { error: "unknown thread" },
            { status: 404 },
          )
        : yield* HttpServerResponse.json(state);
    }),
  );

  /** Steer the thread's agent — the thread view's chat input posts
   *  here; the transcript itself rides the session socket. */
  const threadSteer = HttpRouter.add(
    "POST",
    "/api/threads/:id",
    Effect.gen(function* () {
      const id = yield* threadId;
      const request = yield* HttpServerRequest;
      const body = (yield* request.json.pipe(
        Effect.catch(() => Effect.succeed({})),
      )) as { text?: string };
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (text.length === 0) {
        return yield* HttpServerResponse.json(
          { error: "text required" },
          { status: 400 },
        );
      }
      yield* threadAgent.send(text, { key: id });
      return yield* HttpServerResponse.json({ ok: true }, { status: 202 });
    }),
  );

  const threadClose = HttpRouter.add(
    "POST",
    "/api/threads/:id/close",
    Effect.gen(function* () {
      const id = yield* threadId;
      return yield* HttpServerResponse.json(yield* threads.close(id));
    }),
  );

  /**
   * DELETE a thread — everything it was, in an order that leaves no
   * one running. The response answers only when it is all done, and
   * the thread's directory row is the LAST thing to go, so a rail
   * showing the row as "deleting" is telling the truth:
   *
   * 1. the snapshot (`threads.get`) — the book of what to tear down;
   * 2. the pull requests' worktrees on its machine (`worktree` tool
   *    trees, `pullWorktreeKey`) — dropped through `Git.Checkouts`
   *    while the machine still answers; a tree that IS the machine's
   *    disk (`.`) goes with the machine below;
   * 3. the thread agent's own session — settle + cut its round (a
   *    `spawn` mid-await dies here, so no waiter re-books an agent)
   *    and take the machine down with it;
   * 4. EVERY session descended from it, machine spared (they shared
   *    the thread's — the key's `::` prefix): the engineers the
   *    thread's agent rows name AND whatever the session index's
   *    parent edges reach beyond them (an engineer's own dispatches,
   *    a row the thread never got to book). Each settles and has its
   *    round cut, so an engineer mid-command stops. Anonymous
   *    `spawn-*` workers are skipped: they run inside their spawner's
   *    round and died with it in step 3;
   * 5. its DO and channel projections (`threads.remove`).
   *
   * Idempotent on an unknown id.
   */
  const threadDelete = HttpRouter.add(
    "DELETE",
    "/api/threads/:id",
    Effect.gen(function* () {
      const id = yield* threadId;
      const snap = yield* threads.get(id);
      // THE ORDER: agents first, trees second, the record last. The
      // agents are the ones still writing into the trees, so they are
      // stopped (rounds cut, machines released) before a tree goes;
      // the record goes last so the thread reads as "deleting" until
      // everything under it is actually gone.
      yield* sessions
        .remove(THREAD_TERM, id)
        .pipe(Effect.provide(RuntimeContext.phantom));
      const descendants = new Map<string, { term: string; key: string }>();
      for (const agent of snap?.agents ?? []) {
        descendants.set(AI.sessionId(engineerTerm, agent.key), {
          term: engineerTerm,
          key: agent.key,
        });
      }
      // the index's parent edges, walked transitively from the thread's
      // session — a directory, so a stale or absent index only means
      // fewer rows here, never a wrong one
      const listed = yield* sessions.list();
      const frontier = [AI.sessionId(THREAD_TERM, id), ...descendants.keys()];
      while (frontier.length > 0) {
        const parent = frontier.pop()!;
        for (const row of listed) {
          if (
            row.parent !== parent ||
            descendants.has(row.id) ||
            row.key.startsWith("spawn-")
          ) {
            continue;
          }
          descendants.set(row.id, { term: row.term, key: row.key });
          frontier.push(row.id);
        }
      }
      yield* Effect.forEach(
        descendants.values(),
        ({ term, key }) => sessions.remove(term, key, { machine: false }),
        { discard: true, concurrency: 8 },
      ).pipe(Effect.provide(RuntimeContext.phantom));
      if (Option.isSome(checkouts)) {
        yield* Effect.forEach(
          (snap?.entities ?? []).flatMap((entity) => {
            const parsed = parseEntityRef(entity.ref);
            return entity.worktree === undefined ||
              entity.worktree === "." ||
              entity.worktree === "" ||
              parsed === undefined
              ? []
              : [pullWorktreeKey(id, parsed.number)];
          }),
          (key) =>
            checkouts.value.release(key).pipe(
              Effect.provideService(AI.Thread, phantomThread(id)),
              Effect.catch((error) =>
                Effect.logWarning(
                  `deleting thread '${id}': dropping worktree '${key}' failed (contained): ${error.message}`,
                ),
              ),
            ),
          { discard: true },
        );
      }
      yield* threads.remove(id);
      return yield* HttpServerResponse.json({ ok: true });
    }),
  );

  /* ── a thread's agents: the operator's switches on one engineer ─── */

  /** `:id/agents/:key` → the thread and the agent's row, or a 404. */
  const agentParams = Effect.gen(function* () {
    const id = yield* threadId;
    const params = yield* HttpRouter.params;
    const key = decodeURIComponent(String(params.key ?? ""));
    const snap = yield* threads.get(id);
    const row = snap?.agents.find((agent) => agent.key === key);
    return { id, key, row };
  });
  const noSuchAgent = (id: string, key: string) =>
    HttpServerResponse.json(
      { error: `thread ${id} has no agent ${key}` },
      { status: 404 },
    );
  /**
   * STOP an agent: the off switch. Its session settles (the round in
   * flight — a command on the machine — is cut) and the books say
   * stopped. The thread's spawn tool, waiting on the dispatch, is
   * answered with the Stopped outcome and records the same.
   */
  const agentStop = HttpRouter.add(
    "POST",
    "/api/threads/:id/agents/:key/stop",
    Effect.gen(function* () {
      const { id, key, row } = yield* agentParams;
      if (row === undefined) return yield* noSuchAgent(id, key);
      yield* sessions
        .stop(engineerTerm, key)
        .pipe(Effect.provide(RuntimeContext.phantom));
      const state = yield* threads.agentUpsert(id, {
        ...row,
        state: "stopped",
        settledAt: Date.now(),
      });
      return yield* HttpServerResponse.json(state);
    }),
  );

  /**
   * RESUME a stopped (or finished) agent: the tombstone is cleared and
   * the session takes input again — the operator steers it from its
   * pane. Nothing runs until something is said to it.
   */
  const agentResume = HttpRouter.add(
    "POST",
    "/api/threads/:id/agents/:key/resume",
    Effect.gen(function* () {
      const { id, key, row } = yield* agentParams;
      if (row === undefined) return yield* noSuchAgent(id, key);
      yield* sessions
        .resume(engineerTerm, key)
        .pipe(Effect.provide(RuntimeContext.phantom));
      const { settledAt: _settled, ...rest } = row;
      const state = yield* threads.agentUpsert(id, {
        ...rest,
        state: "running",
      });
      return yield* HttpServerResponse.json(state);
    }),
  );

  /** DELETE an agent: its session is erased (round cut, transcript
   *  purged; the thread's machine is shared and stays) and its row
   *  leaves the books. */
  const agentDelete = HttpRouter.add(
    "DELETE",
    "/api/threads/:id/agents/:key",
    Effect.gen(function* () {
      const { id, key, row } = yield* agentParams;
      if (row === undefined) return yield* noSuchAgent(id, key);
      yield* sessions
        .remove(engineerTerm, key, { machine: false })
        .pipe(Effect.provide(RuntimeContext.phantom));
      const state = yield* threads.agentRemove(id, key);
      return yield* HttpServerResponse.json(state);
    }),
  );

  /* ── pull requests: on-demand GitHub reads for the review view ──── */

  /** `:owner/:repo/:number` → the PR number, when the repo is the
   *  connected one (nothing else is served). */
  const pullParams = Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const full = `${params.owner}/${params.repo}`;
    const number = Number(params.number);
    if (full !== repoName || !Number.isFinite(number) || number <= 0) {
      return undefined;
    }
    return number;
  });

  // plain-data TTL caches — one operator polling must not burn the
  // GitHub rate limit (see the old Routes for why not cachedWithTTL:
  // workerd pins shared promises to their creating request)
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

  const pullRequest = HttpRouter.add(
    "GET",
    "/api/pulls/:owner/:repo/:number",
    Effect.gen(function* () {
      const number = yield* pullParams;
      if (number === undefined) {
        return yield* HttpServerResponse.json(
          { error: "unknown pull request" },
          { status: 404 },
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

  const pullFilesCache = new Map<
    string,
    { at: number; value: PullRequestFilesPage }
  >();
  const pullRequestFiles = HttpRouter.add(
    "GET",
    "/api/pulls/:owner/:repo/:number/files",
    Effect.gen(function* () {
      const number = yield* pullParams;
      if (number === undefined) {
        return yield* HttpServerResponse.json(
          { error: "unknown pull request" },
          { status: 404 },
        );
      }
      const request = yield* HttpServerRequest;
      const pageRaw = Number(
        new URL(request.url, "http://org").searchParams.get("page") ?? "1",
      );
      const page =
        Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : undefined;
      if (page === undefined) {
        return yield* HttpServerResponse.json(
          { error: "bad page" },
          { status: 400 },
        );
      }
      const key = `${number}:${page}`;
      const now = Date.now();
      const cached = pullFilesCache.get(key);
      const result =
        cached !== undefined && now - cached.at < 15_000
          ? cached.value
          : yield* listPullFiles({
              pull_number: number,
              per_page: PULL_FILES_PAGE_SIZE,
              page,
            }).pipe(
              Effect.map((files) => buildPullRequestFilesPage(files, page)),
              Effect.tap((value) =>
                Effect.sync(() => pullFilesCache.set(key, { at: now, value })),
              ),
              Effect.catch((error) =>
                Effect.succeed({
                  error: `${error.operation}: ${error.message}`,
                }),
              ),
            );
      if ("error" in result) {
        return yield* HttpServerResponse.json(result, { status: 404 });
      }
      return yield* HttpServerResponse.json(result);
    }),
  );

  /* ── sessions: transcript reads + the terminal door ─────────────── */

  const sessionMessages = HttpRouter.add(
    "GET",
    "/api/chats/:id/messages",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const { term, key } = parseSessionId(
        decodeURIComponent(String(params.id ?? "")),
      );
      // an unknown session is an EMPTY one — the conversation exists
      // from the first visit, before any message has been sent
      const log = yield* sessions
        .history(term, key)
        .pipe(Effect.provide(RuntimeContext.phantom));
      return yield* HttpServerResponse.json(AI.toUIMessages(log));
    }),
  );

  /**
   * Delete chat messages (`{ ids }`): resolve each UIMessage id
   * (`u-<seq>`, `a-<seq>`, `crash-<seq>`) to its observation span and
   * redact the union. Projection-only — the model's working context
   * is untouched.
   */
  const sessionMessagesDelete = HttpRouter.add(
    "DELETE",
    "/api/chats/:id/messages",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const { term, key } = parseSessionId(
        decodeURIComponent(String(params.id ?? "")),
      );
      const ids = yield* readIds(yield* HttpServerRequest);
      if (ids.length === 0) {
        return yield* HttpServerResponse.json(
          { error: "ids required" },
          { status: 400 },
        );
      }
      const log = yield* sessions
        .history(term, key)
        .pipe(Effect.provide(RuntimeContext.phantom));
      const seqs = [
        ...new Set(ids.flatMap((id) => AI.observationSpan(log, id))),
      ];
      if (seqs.length === 0) {
        return yield* HttpServerResponse.json(
          { error: "unknown messages" },
          { status: 404 },
        );
      }
      yield* sessions
        .redact(term, key, seqs)
        .pipe(Effect.provide(RuntimeContext.phantom));
      return yield* HttpServerResponse.json({ deleted: seqs.length });
    }),
  );

  /**
   * The stop button: abort the session's round in flight. The session
   * stays alive — the next message opens a fresh round. A parked
   * session is a no-op.
   */
  const sessionInterrupt = HttpRouter.add(
    "POST",
    "/api/chats/:id/interrupt",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const { term, key } = parseSessionId(
        decodeURIComponent(String(params.id ?? "")),
      );
      yield* sessions
        .interrupt(term, key)
        .pipe(Effect.provide(RuntimeContext.phantom));
      return yield* HttpServerResponse.json({ ok: true });
    }),
  );

  const sessionLog = HttpRouter.add(
    "GET",
    "/api/chats/:id/log",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const params = yield* HttpRouter.params;
      const { term, key } = parseSessionId(
        decodeURIComponent(String(params.id ?? "")),
      );
      const limitRaw = new URL(request.url, "http://worker").searchParams.get(
        "limit",
      );
      const limit = limitRaw === null ? undefined : Number(limitRaw);
      const log = yield* sessions
        .history(term, key)
        .pipe(Effect.provide(RuntimeContext.phantom));
      const observations =
        limit !== undefined && Number.isFinite(limit) && limit > 0
          ? log.slice(-limit)
          : log;
      return yield* HttpServerResponse.json(observations);
    }),
  );

  /** Run one command on a session's machine — REPL-grade, not a PTY
   *  (the PTY rides the `/terminal` socket). */
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

  /* ── identity + repos ───────────────────────────────────────────── */

  const whoami = HttpRouter.add(
    "GET",
    "/api/me",
    Effect.gen(function* () {
      return yield* HttpServerResponse.json(yield* readOperator);
    }),
  );

  const listRepos = HttpRouter.add(
    "GET",
    "/api/repos",
    Effect.gen(function* () {
      return yield* HttpServerResponse.json(repos);
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
    channelPage,
    channelPost,
    channelMessagesDelete,
    channelDirectory,
    threadState,
    threadSteer,
    threadClose,
    threadDelete,
    agentStop,
    agentResume,
    agentDelete,
    pullRequest,
    pullRequestFiles,
    sessionMessages,
    sessionMessagesDelete,
    sessionInterrupt,
    sessionLog,
    sessionExec,
    whoami,
    listRepos,
    status,
  );
});
