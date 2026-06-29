import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Coder } from "./Coder.ts";
import { ReadTrackerObject } from "./ReadTracker.ts";
import { Sandbox } from "./Sandbox.ts";
import { BashLive } from "./tools/Bash.ts";
import { CloneLive } from "./tools/Clone.ts";
import { EditLive } from "./tools/Edit.ts";
import { EvalLive } from "./tools/Eval.ts";
import { GlobLive } from "./tools/Glob.ts";
import { GrepLive } from "./tools/Grep.ts";
import { ReadLive } from "./tools/Read.ts";
import { SqlLive } from "./tools/Sql.ts";
import { WebFetchLive } from "./tools/WebFetch.ts";
import { WriteLive } from "./tools/Write.ts";

/** A coding job handed to the Coder agent for a single post. */
export interface CoderJob {
  /** The prompt describing what to build. */
  prompt: string;
  /** A repo to clone first (forks/replies); omit for a root post (empty repo). */
  repo?: { remote: string; token: string };
}

/**
 * All of the Coder's tools, wired to the session's substrate: the filesystem +
 * shell tools run against the {@link Sandbox} container, `read`/`write`/`edit`
 * gate on the DO-backed {@link ReadTrackerObject}, `sql` uses this DO's SQLite
 * storage, and `eval` runs in a sandboxed Worker isolate.
 */
const Tools = Layer.mergeAll(
  BashLive,
  ReadLive,
  WriteLive,
  EditLive,
  GlobLive,
  GrepLive,
  CloneLive,
  EvalLive,
  SqlLive,
  WebFetchLive,
).pipe(
  Layer.provideMerge(ReadTrackerObject),
  Layer.provideMerge(
    Cloudflare.layerContainer(Sandbox, { enableInternet: true }),
  ),
  Layer.provideMerge(Cloudflare.layerChatDurableObject),
);

/**
 * The Coder session — one Durable Object instance per post that owns a running
 * sandbox and drives the {@link Coder} agent against it. Bind it by the post's
 * id (`CoderSession.getByName(postId)`) so each post gets its own isolated
 * workspace, scratch database, and read-state.
 */
export class CoderSession extends Cloudflare.DurableObject<CoderSession>()(
  "CoderSession",
  Effect.gen(function* () {
    const coder = yield* Coder;

    return Effect.gen(function* () {
      return {
        /**
         * Kick off the Coder agent on a job. The agent run is long-lived, so it
         * is forked to run in the background and `run` returns immediately; the
         * caller polls the post/thread to watch the code land.
         */
        run: Effect.fn("run")(function* (job: CoderJob) {
          yield* Effect.forkDetach(coder.send({ input: job }));
        }),
      };
    });
  }).pipe(Effect.provide(Tools)),
) {}
