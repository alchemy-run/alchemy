import type { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { CoderSession } from "./agent/Session.ts";
import { Post, type PostKind, type PostRecord, type ReplyPointer } from "./Post.ts";
import { Repos } from "./Repos.ts";

/** A post plus its replies expanded recursively — the shape of `/thread`. */
interface ThreadNode extends PostRecord {
  thread: ThreadNode[];
}

/** Cap recursion so a malformed/cyclic graph can never hang a request. */
const MAX_THREAD_DEPTH = 16;

const repoNameFor = (id: string) => `post-${id}`;

/**
 * "forked" — Twitter for code repositories.
 *
 * Every post is a repository. You start a post from a prompt against an empty
 * repo; you fork it (retweet) or reply (fork-and-build) to branch the repo and
 * spawn a new post. Each post is a `Post` Durable Object, and replies are
 * pointers to other Durable Objects, so the posts form a graph.
 *
 * Routes:
 * - `POST /posts`            `{ prompt }`  → create a root post (empty repo)
 * - `POST /posts/:id/fork`   `{ prompt? }` → fork a post (retweet)
 * - `POST /posts/:id/reply`  `{ prompt }`  → reply to a post (fork + build)
 * - `GET  /posts/:id`                      → read a single post
 * - `GET  /posts/:id/thread`               → read a post and its replies graph
 */
export default class Feed extends Cloudflare.Worker<Feed>()(
  "Feed",
  { main: import.meta.filename },
  Effect.gen(function* () {
    const posts = yield* Post;
    const coders = yield* CoderSession;
    const repos = yield* Cloudflare.Artifacts.bind(Repos);

    const newId = Effect.sync(() => crypto.randomUUID());

    /**
     * Generate a post: create its repository, then materialize the Durable
     * Object. Returns the new record plus the ephemeral push token so the
     * caller can push the generated code (the token is never persisted).
     *
     * For a root post the repo starts empty; for a fork/reply we branch the
     * parent's repo so the child inherits its history.
     */
    const generate = Effect.fn(function* (input: {
      kind: PostKind;
      prompt: string;
      parent: PostRecord | null;
    }) {
      const id = yield* newId;
      const name = repoNameFor(id);

      const repo = input.parent
        ? yield* repos
            .get(input.parent.repo.name)
            .pipe(
              Effect.flatMap((parentRepo) =>
                parentRepo.fork(name, { description: input.prompt }),
              ),
            )
        : yield* repos.create(name, {
            description: input.prompt,
            setDefaultBranch: "main",
          });

      const record = yield* posts.getByName(id).init({
        id,
        kind: input.kind,
        prompt: input.prompt,
        parentId: input.parent?.id ?? null,
        repo: { name, remote: repo.remote },
      });

      // Hand the post off to its own Coder session to generate the code. `run`
      // forks the agent inside the Durable Object and returns immediately.
      yield* coders.getByName(id).run({
        prompt: input.prompt,
        repo: { remote: repo.remote, token: repo.token },
      });

      return { record, token: repo.token };
    });

    const buildThread: (
      id: string,
      depth: number,
    ) => Effect.Effect<ThreadNode | null, never, RuntimeContext> = Effect.fn(
      function* (id: string, depth: number) {
        const record = yield* posts.getByName(id).snapshot();
        if (!record) return null;
        const thread =
          depth <= 0
            ? []
            : (yield* Effect.forEach(record.replies, (reply) =>
                buildThread(reply.id, depth - 1),
              )).filter((node): node is ThreadNode => node !== null);
        return { ...record, thread };
      },
    );

    const readBody = Effect.fn(function* (request: HttpServerRequest) {
      const text = yield* request.text;
      if (!text) return {} as { prompt?: string };
      return yield* Effect.try(() => JSON.parse(text) as { prompt?: string });
    }, Effect.orElseSucceed(() => ({}) as { prompt?: string }));

    const notFound = HttpServerResponse.text("Not Found", { status: 404 });
    const badRequest = Effect.fn(function* (message: string) {
      return yield* HttpServerResponse.json(
        { error: message },
        { status: 400 },
      );
    });

    /** Create a fork (retweet) or a reply (fork + build) of an existing post. */
    const branch = Effect.fn(function* (
      parentId: string,
      kind: Extract<PostKind, "fork" | "reply">,
      request: HttpServerRequest,
    ) {
      const parent = yield* posts.getByName(parentId).snapshot();
      if (!parent) return notFound;

      const body = yield* readBody(request);
      const prompt = body.prompt ?? parent.prompt;
      if (kind === "reply" && !body.prompt) {
        return yield* badRequest("a reply requires a `prompt`");
      }

      const { record, token } = yield* generate({ kind, prompt, parent });

      const pointer: ReplyPointer = {
        id: record.id,
        kind,
        prompt: record.prompt,
        createdAt: record.createdAt,
      };
      yield* posts.getByName(parentId).addReply(pointer);

      return yield* HttpServerResponse.json(
        { post: record, push: { remote: record.repo.remote, token } },
        { status: 201 },
      );
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://forked");
        const segments = url.pathname.split("/").filter(Boolean);

        // POST /posts — create a root post from a prompt.
        if (
          request.method === "POST" &&
          segments.length === 1 &&
          segments[0] === "posts"
        ) {
          const body = yield* readBody(request);
          if (!body.prompt) return yield* badRequest("`prompt` is required");

          const { record, token } = yield* generate({
            kind: "post",
            prompt: body.prompt,
            parent: null,
          });
          return yield* HttpServerResponse.json(
            { post: record, push: { remote: record.repo.remote, token } },
            { status: 201 },
          );
        }

        if (segments.length >= 2 && segments[0] === "posts") {
          const id = segments[1]!;
          const action = segments[2];

          // POST /posts/:id/fork | /posts/:id/reply
          if (request.method === "POST" && action === "fork") {
            return yield* branch(id, "fork", request);
          }
          if (request.method === "POST" && action === "reply") {
            return yield* branch(id, "reply", request);
          }

          // GET /posts/:id/thread — the post plus its reply graph.
          if (request.method === "GET" && action === "thread") {
            const node = yield* buildThread(id, MAX_THREAD_DEPTH);
            return node
              ? yield* HttpServerResponse.json(node)
              : notFound;
          }

          // GET /posts/:id — a single post.
          if (request.method === "GET" && action === undefined) {
            const record = yield* posts.getByName(id).snapshot();
            return record ? yield* HttpServerResponse.json(record) : notFound;
          }
        }

        return notFound;
      }).pipe(
        Effect.catchTag("ArtifactsError", (error) =>
          HttpServerResponse.json(
            { error: error.message },
            { status: 502 },
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.ArtifactsBindingLive)),
) {}
