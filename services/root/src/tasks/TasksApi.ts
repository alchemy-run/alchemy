import * as Cloudflare from "alchemy/Cloudflare";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Posts } from "../chat/Posts.ts";
import { Desks } from "./Desks.ts";
import { TaskIntake } from "./Intake.ts";
import {
  isTaskState,
  Tasks,
  TASK_STATES,
  type TaskState,
} from "./TasksDO.ts";

/** The wire's tags — an array of non-empty strings, or nothing. */
const parseTags = (raw: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(raw)
    ? raw
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
    : undefined;

/**
 * The TASKS surface — the board over HTTP:
 *
 * - `GET  /api/tasks/queues`             — registered queues + desk states
 * - `GET  /api/tasks/:queue`             — the board (tasks by state)
 * - `GET  /api/tasks/:queue/:id`         — one task + its timeline
 * - `POST /api/tasks`                    — file `{title, body, tags?}`
 *   (the router assigns the area tag when `tags` is absent; unsure
 *   lands in inbox, untagged)
 * - `POST /api/tasks/:queue/:id/route`   — human override `{state, desk?}`
 * - `POST /api/tasks/:queue/:id/retag`   — replace the tags `{tags}`
 * - `POST /api/tasks/:queue/:id/comment` — a comment into the task thread
 *
 * Every mutation pumps the queue's desks (Desks.ts) and schedules a
 * debounced follow-up pump — the TriagePump sleeper pattern — so a
 * round that settles after the response still re-arms the loop.
 */
export const TasksApi = Effect.gen(function* () {
  const tasks = yield* Tasks;
  const desks = yield* Desks;
  const intake = yield* TaskIntake;
  const posts = yield* Posts;
  const exec = yield* Cloudflare.WorkerExecutionContext;

  /** The human's identity, until auth exists (mirrors ChannelsApi). */
  const HUMAN = "sam";

  const knownQueue = Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    const slug = String(params.queue ?? "");
    return desks.queues().find((queue) => queue.slug === slug);
  });

  /** Pump now (after the response) and once more after a debounce —
   *  a settling desk round re-arms the loop without a standing alarm. */
  const rearm = (queue: string) =>
    Effect.gen(function* () {
      yield* exec.waitUntil(desks.pump(queue));
      yield* exec.waitUntil(
        Effect.andThen(Effect.sleep("15 seconds"), desks.pump(queue)),
      );
    });

  const queuesRoute = Effect.gen(function* () {
    const views = yield* Effect.forEach(desks.queues(), (queue) =>
      Effect.gen(function* () {
        const members = yield* Effect.forEach(queue.members, (member) =>
          Effect.gen(function* () {
            const state = yield* tasks.deskState(queue.slug, member.slug);
            return {
              term: member.term,
              slug: member.slug,
              deskKey: desks.deskKey(queue.slug, member.slug),
              working: state.working?.id,
              recent: state.recent,
            };
          }),
        );
        return {
          name: queue.name,
          slug: queue.slug,
          prose: queue.prose,
          desks: members,
        };
      }),
    );
    return yield* HttpServerResponse.json({ queues: views });
  });

  /** Board READS also pump, debounced per queue — this is what heals
   *  a desk wedged by an isolate reload (recoverDesk in Desks.ts):
   *  nothing mutates after a reload, but someone always looks. */
  const lastPump = new Map<string, number>();
  const pumpOnRead = (queue: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (now - (lastPump.get(queue) ?? 0) < 10_000) return;
      lastPump.set(queue, now);
      yield* exec.waitUntil(desks.pump(queue));
    });

  const board = Effect.gen(function* () {
    const queue = yield* knownQueue;
    if (queue === undefined) {
      return yield* HttpServerResponse.json(
        { error: "no such queue" },
        { status: 404 },
      );
    }
    yield* pumpOnRead(queue.slug);
    const rows = yield* tasks.list(queue.slug);
    const byState = Object.fromEntries(
      TASK_STATES.map((state) => [
        state,
        rows.filter((row) => row.state === state),
      ]),
    ) as Record<TaskState, unknown>;
    return yield* HttpServerResponse.json({ queue: queue.slug, tasks: byState });
  });

  const one = Effect.gen(function* () {
    const queue = yield* knownQueue;
    if (queue === undefined) {
      return yield* HttpServerResponse.json(
        { error: "no such queue" },
        { status: 404 },
      );
    }
    const params = yield* HttpRouter.params;
    const id = String(params.id ?? "");
    const task = yield* tasks.get(queue.slug, id);
    if (task === undefined) {
      return yield* HttpServerResponse.json(
        { error: "no such task" },
        { status: 404 },
      );
    }
    const events = yield* tasks.events(queue.slug, id);
    return yield* HttpServerResponse.json({ task, events });
  });

  const file = Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const body = (yield* request.json.pipe(
      Effect.catch(() => Effect.succeed({})),
    )) as {
      title?: string;
      body?: string;
      tags?: unknown;
      origin?: string;
      priority?: number;
    };
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (title.length === 0) {
      return yield* HttpServerResponse.json(
        { error: "title required" },
        { status: 400 },
      );
    }
    const tags = parseTags(body.tags);
    const task = yield* intake.file({
      title,
      body: typeof body.body === "string" ? body.body : "",
      ...(tags === undefined || tags.length === 0 ? {} : { tags }),
      ...(typeof body.origin === "string" ? { origin: body.origin } : {}),
      ...(typeof body.priority === "number"
        ? { priority: body.priority }
        : {}),
      actor: HUMAN,
    });
    if (task === undefined) {
      return yield* HttpServerResponse.json(
        { error: "no queues registered" },
        { status: 409 },
      );
    }
    yield* rearm(task.queue);
    return yield* HttpServerResponse.json({ task }, { status: 201 });
  });

  const route = Effect.gen(function* () {
    const queue = yield* knownQueue;
    if (queue === undefined) {
      return yield* HttpServerResponse.json(
        { error: "no such queue" },
        { status: 404 },
      );
    }
    const params = yield* HttpRouter.params;
    const id = String(params.id ?? "");
    const request = yield* HttpServerRequest;
    const body = (yield* request.json.pipe(
      Effect.catch(() => Effect.succeed({})),
    )) as { state?: string; desk?: string; data?: string };
    if (typeof body.state !== "string" || !isTaskState(body.state)) {
      return yield* HttpServerResponse.json(
        { error: "state required" },
        { status: 400 },
      );
    }
    const task = yield* tasks.route(queue.slug, id, {
      state: body.state,
      ...(typeof body.desk === "string" ? { desk: body.desk } : {}),
      // the note the hop rides — a park's reason, a reroute's why
      ...(typeof body.data === "string" && body.data.length > 0
        ? { data: body.data }
        : {}),
      actor: HUMAN,
    });
    if (task === undefined) {
      return yield* HttpServerResponse.json(
        { error: "no such task or illegal transition" },
        { status: 409 },
      );
    }
    yield* rearm(queue.slug);
    return yield* HttpServerResponse.json({ task });
  });

  const retag = Effect.gen(function* () {
    const queue = yield* knownQueue;
    if (queue === undefined) {
      return yield* HttpServerResponse.json(
        { error: "no such queue" },
        { status: 404 },
      );
    }
    const params = yield* HttpRouter.params;
    const id = String(params.id ?? "");
    const request = yield* HttpServerRequest;
    const body = (yield* request.json.pipe(
      Effect.catch(() => Effect.succeed({})),
    )) as { tags?: unknown };
    const tags = parseTags(body.tags);
    if (tags === undefined) {
      return yield* HttpServerResponse.json(
        { error: "tags required" },
        { status: 400 },
      );
    }
    const task = yield* tasks.retag(queue.slug, id, tags, HUMAN);
    if (task === undefined) {
      return yield* HttpServerResponse.json(
        { error: "no such task" },
        { status: 404 },
      );
    }
    yield* rearm(queue.slug);
    return yield* HttpServerResponse.json({ task });
  });

  const comment = Effect.gen(function* () {
    const queue = yield* knownQueue;
    if (queue === undefined) {
      return yield* HttpServerResponse.json(
        { error: "no such queue" },
        { status: 404 },
      );
    }
    const params = yield* HttpRouter.params;
    const id = String(params.id ?? "");
    const task = yield* tasks.get(queue.slug, id);
    if (task === undefined) {
      return yield* HttpServerResponse.json(
        { error: "no such task" },
        { status: 404 },
      );
    }
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
    const minted = yield* Clock.currentTimeMillis;
    const post = `p-${minted.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    yield* posts.post({
      id: post,
      channel: `tasks:${queue.slug}`,
      ...(task.rootPost === undefined ? {} : { replyTo: task.rootPost }),
      author: HUMAN,
      text,
      status: "settled",
    });
    yield* tasks.comment(queue.slug, id, HUMAN, post);
    yield* rearm(queue.slug);
    return yield* HttpServerResponse.json({ post }, { status: 201 });
  });

  return Layer.mergeAll(
    // the static path registers first — `queues` is never a queue slug
    HttpRouter.add("GET", "/api/tasks/queues", queuesRoute),
    HttpRouter.add("GET", "/api/tasks/:queue", board),
    HttpRouter.add("GET", "/api/tasks/:queue/:id", one),
    HttpRouter.add("POST", "/api/tasks", file),
    HttpRouter.add("POST", "/api/tasks/:queue/:id/route", route),
    HttpRouter.add("POST", "/api/tasks/:queue/:id/retag", retag),
    HttpRouter.add("POST", "/api/tasks/:queue/:id/comment", comment),
  );
});
