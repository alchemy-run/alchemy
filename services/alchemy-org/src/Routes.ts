/**
 * The org's HTTP surface — the SAME routes on both entrypoints
 * (Server.ts locally, Worker.ts on Cloudflare): the desks' sealed
 * read-only status, the chat projection in the AI SDK UIMessage
 * protocol, the issue board, and the operator's approval key.
 *
 * `orgRoutes` resolves its services from the entrypoint's org
 * composition and returns the router layer; the entrypoint merges any
 * substrate-only routes (the Worker adds the run-socket attach) and
 * serves.
 */
import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Approvals } from "./services/Approvals.ts";
import { buildBoard } from "./lib/Board.ts";
import { Issues, PullRequests } from "./Org.ts";
import { testAlchemy } from "./Repos.ts";

export const orgRoutes = Effect.gen(function* () {
  // the desks are BINDINGS: resolved at init, closed over by fetch
  const issues = yield* Issues;
  const pullRequests = yield* PullRequests;
  const chats = yield* AI.Chats;
  const approvals = yield* Approvals;
  // sendMessage's honest door: a chat message to a desk becomes a
  // GitHub comment — the same world event as any other steer
  const comment = yield* GitHub.CreateIssueComment(testAlchemy);

  const sseHeaders = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-vercel-ai-ui-message-stream": "v1",
    "x-accel-buffering": "no",
  };
  const encoder = new TextEncoder();

  const listChats = HttpRouter.add(
    "GET",
    "/api/chats",
    Effect.gen(function* () {
      return yield* HttpServerResponse.json(yield* chats.list());
    }),
  );

  // the ISSUE BOARD: every chat grouped under the GitHub issue it
  // serves, via channel keys + kernel dispatch parentage (Board.ts)
  const board = HttpRouter.add(
    "GET",
    "/api/board",
    Effect.gen(function* () {
      const [chatList, openIssues] = yield* Effect.all(
        [
          chats.list(),
          issues.list().pipe(
            Effect.map((list) =>
              list.map((issue) => ({
                number: issue.number,
                title: issue.title,
              })),
            ),
            // GitHub down ≠ board down: states degrade to "unknown"
            Effect.catch(() => Effect.succeed(undefined)),
          ),
        ] as const,
        { concurrency: 2 },
      );
      return yield* HttpServerResponse.json(buildBoard(chatList, openIssues));
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

  const chatStream = HttpRouter.add(
    "POST",
    "/api/chat",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const body = (yield* request.json.pipe(Effect.orDie)) as {
        id?: string;
        messages?: Array<{
          role?: string;
          parts?: Array<{ type?: string; text?: string }>;
        }>;
      };
      const id = body.id ?? "";
      const [term = "", key = ""] = ((at) =>
        at < 0 ? [] : [id.slice(0, at), id.slice(at + 1)])(id.indexOf(":"));
      const last = body.messages?.at(-1);
      const text =
        last?.role === "user"
          ? (last.parts ?? [])
              .filter((part) => part.type === "text")
              .map((part) => part.text ?? "")
              .join("\n")
              .trim()
          : "";

      // deliver the text through the WORLD's door: a GitHub comment
      // on the owner's issue steers the run like any other event;
      // chats without a world door are watch-only. Live view is the
      // run socket (`/attach` / useAgent) — not this response body.
      const threadNumber = Number(key.match(/#(\d+)$/)?.[1]);
      if (
        text.length > 0 &&
        term === "IssueOwner" &&
        Number.isFinite(threadNumber)
      ) {
        yield* comment({
          issue_number: threadNumber,
          body: text,
        }).pipe(Effect.orDie);
        return yield* HttpServerResponse.json({ ok: true });
      }

      // Non-IssueOwner threads: legacy HTTP SSE tail (local only —
      // ChatsCloudflare's subscribe has no live queue). Prefer
      // useAgent/useChat over /attach for the live view.
      const { queue, unsubscribe } = yield* chats.subscribe(
        id,
        Number.MAX_SAFE_INTEGER,
      );
      const translate = AI.makeChunkTranslator();
      const DONE = "__done__";
      const stream = Stream.fromQueue(queue).pipe(
        Stream.flatMap((observation: AI.KernelObservation) => {
          const { chunks, done } = translate(observation);
          const lines = chunks.map(
            (chunk) => `data: ${JSON.stringify(chunk)}\n\n`,
          );
          return Stream.fromArray(done ? [...lines, DONE] : lines);
        }),
        Stream.takeWhile((line: string) => line !== DONE),
        // a silent run should not hold sockets forever
        Stream.interruptWhen(Effect.sleep("5 minutes")),
        Stream.concat(Stream.make("data: [DONE]\n\n")),
        Stream.map((line: string) => encoder.encode(line)),
        Stream.catch(() => Stream.empty),
        Stream.ensuring(unsubscribe),
      ) as Stream.Stream<Uint8Array>;
      return HttpServerResponse.stream(stream, { headers: sseHeaders });
    }),
  );

  // ── the HUMAN's key (supervised mode): approve a PR ──────────────
  // Records into the SAME approvals ledger the merge tool ratifies
  // against — the org-console equivalent of a GitHub APPROVED review
  // (which the sandbox's single token cannot submit on its own PRs).
  const approvePullRequest = HttpRouter.add(
    "POST",
    "/api/prs/:number/approve",
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const number = Number(params.number);
      if (!Number.isFinite(number)) {
        return yield* HttpServerResponse.json(
          { error: "bad pull request number" },
          { status: 400 },
        );
      }
      const identity = yield* GitHub.resolveRepository(testAlchemy);
      const key = {
        owner: identity.owner,
        repository: identity.repository,
        number,
      };
      // IDEMPOTENT: a retried POST (an interrupted curl, a double
      // click) must not spam the PR with duplicate comments
      if (yield* approvals.isApproved(key)) {
        return yield* HttpServerResponse.json({
          approved: number,
          already: true,
        });
      }
      yield* approvals.record(key);
      yield* comment({
        issue_number: number,
        body: "✅ **Approved by the operator** (org console) — the merge is authorized.",
      }).pipe(Effect.orDie);
      return yield* HttpServerResponse.json({ approved: number });
    }),
  );

  const status = HttpRouter.add(
    "GET",
    "/api/status",
    Effect.gen(function* () {
      const snapshot = yield* Effect.all(
        {
          issues: issues.list(),
          pullRequests: pullRequests.list(),
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map(({ issues, pullRequests }) => ({
          phase: "running",
          openIssues: issues.map((issue) => ({
            number: issue.number,
            title: issue.title,
          })),
          openPullRequests: pullRequests.map((pull) => ({
            number: pull.number,
            title: pull.title,
          })),
        })),
        Effect.catch((error) =>
          Effect.succeed({
            phase: "degraded",
            error: String(error),
          } as const),
        ),
      );
      return yield* HttpServerResponse.json(snapshot);
    }),
  );

  /** Directory feed: SSE snapshots of the issue board as chats change. */
  const boardStream = HttpRouter.add(
    "GET",
    "/api/board/stream",
    Effect.gen(function* () {
      const readBoard = Effect.gen(function* () {
        const [chatList, openIssues] = yield* Effect.all(
          [
            chats.list(),
            issues.list().pipe(
              Effect.map((list) =>
                list.map((issue) => ({
                  number: issue.number,
                  title: issue.title,
                })),
              ),
              Effect.catch(() => Effect.succeed(undefined)),
            ),
          ] as const,
          { concurrency: 2 },
        );
        return buildBoard(chatList, openIssues);
      });

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

      return HttpServerResponse.stream(stream, {
        headers: sseHeaders,
      });
    }),
  );

  return Layer.mergeAll(
    listChats,
    board,
    boardStream,
    chatMessages,
    chatLog,
    chatStream,
    approvePullRequest,
    status,
  );
});
