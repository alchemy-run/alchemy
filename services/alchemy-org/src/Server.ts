/**
 * The org, running on your machine — an Effectful {@link Local.Vite}
 * service hosting both agents as a detached local process:
 *
 * - the ENGINEER — the resident coding agent, one durable chat per
 *   thread, working the operator's own checkout;
 * - the REVIEW BOT — the pipeline over the sandbox repository: every
 *   pull request opened there admits a durable review session that
 *   checks out `pull/N/head`, verifies by reading and RUNNING, and
 *   posts one review.
 *
 * Both interpret on the SAME driver assembly (services/Driver.ts:
 * sqlite session storage + the Anthropic LanguageModel + the session
 * index riding the event stream), under one HTTP surface (Routes.ts),
 * with the UI built by Vite and served from the same address.
 *
 * Long-lived machinery (the GitHub poller, driver run loops)
 * registers on the process Scope — so plain `Effect.provide(Org)` is
 * enough; the fibers survive init returning. GitHub credentials
 * resolve from the alchemy profile (`alchemy login`) or the GitHub
 * App env (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`); running
 * additionally needs `ANTHROPIC_API_KEY` in the operator's
 * environment (the reconciler passes the shell env through).
 */
import * as AI from "alchemy/AI";
import * as Git from "alchemy/Git";
import * as GitHub from "alchemy/GitHub";
import * as Local from "alchemy/Local";
import * as Workspace from "alchemy/Workspace";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { GeneralEngineer } from "./Engineer.ts";
import { ReviewBotEvents, ReviewBotLive } from "./ReviewBot.ts";
import { orgRoutes } from "./Routes.ts";
import { DriverLocal } from "./services/Driver.ts";
import { EventsLocal } from "./services/Events.ts";
import { Credentials, GitHubLocal } from "./services/GitHubLocal.ts";
import { SqliteLedger } from "./services/LedgerSqlite.ts";
import { QualityAssuranceGeneral } from "./skills/QualityAssurance.ts";
import { ReadDiffLive, ReadIssueLive } from "./tools/index.ts";
import { ReadTools, RunTools, WriteTools } from "./tools/Toolbox.ts";

/** The engineer's desk: the operator's own checkout. */
const workspaceRoot = process.env.CODER_WORKSPACE ?? `${process.cwd()}/../..`;

/**
 * The review worktrees ROOT — one directory holds the central blobless
 * clone and the per-PR worktrees (`Git.WorkspacesWorktree` populates
 * it). `ORG_WORKSPACE` overrides the location.
 */
const worktreesRoot =
  process.env.ORG_WORKSPACE ?? `${process.cwd()}/.alchemy/workspaces`;

/** Checkouts as a capability: central clone + one worktree per PR.
 *  ONE instance — the charter's init checkout and the toolbox root
 *  share the cache (same const, memoized by reference). */
const WorkspacesLive = Git.WorkspacesWorktree({ root: worktreesRoot }).pipe(
  Layer.provide(GitHub.GitCredentials),
  Layer.provide(Credentials),
);

/**
 * ONE toolbox for both agents — layers memoize by reference, so a
 * single Sandbox over a single routed Workspace serves everyone: a
 * review session's tools resolve its PR worktree (`Workspace.perRun`
 * derives the root from `AI.Thread` at call time), the engineer's
 * sessions (no checkout) fall back to the fixed desk. Capability
 * still splits by MENTION: the review charter names only read/run
 * tools, so the editor in context is not in its toolkit.
 */
const Toolbox = Layer.mergeAll(ReadTools, RunTools, WriteTools).pipe(
  Layer.provide(AI.SandboxLocal),
  Layer.provide(Workspace.perRun({ fallback: workspaceRoot })),
);

/** The engineer over the shared toolbox and driver. */
const EngineerLocal = GeneralEngineer.pipe(Layer.provide(Toolbox));

/** The review pipeline: router + charter + review-only capabilities. */
const ReviewBotLocal = ReviewBotEvents.pipe(
  // provideMERGE: the HTTP edge addresses the bot too (the operator's
  // click-to-review sends it a synthetic opened event)
  Layer.provideMerge(Layer.suspend(() => ReviewBotLive)),
  Layer.provide([QualityAssuranceGeneral, ReadDiffLive, ReadIssueLive]),
  Layer.provide(Toolbox),
  Layer.provide(EventsLocal),
  Layer.provideMerge(SqliteLedger(".alchemy/review-ledger.sqlite")),
);

/**
 * The whole org over LOCAL physics. The driver bundle is
 * provideMERGED because the HTTP edge consumes it too:
 * `SessionSockets` for the `/attach` door, `SessionIndex` for the
 * board, `ThreadStorage` for transcripts. GitHub physics
 * (profile/app credentials, REST polling, the Local bindings) and
 * the worktree cache sit under both agents.
 */
export const Org = Layer.mergeAll(EngineerLocal, ReviewBotLocal).pipe(
  Layer.provideMerge(DriverLocal),
  Layer.provideMerge(WorkspacesLive),
  Layer.provideMerge(GitHubLocal),
  Layer.orDie,
);

export default class OrgServer extends Local.Vite<OrgServer>()(
  "Engineer",
  {
    // no port pinned: the runtime binds an ephemeral one and reports it
    // back through the startup handshake — it lands in the `url` output.
    // The UI (ui/, built by Local.Vite at deploy) is served from the
    // SAME server, so there is no second address to keep in sync.
    main: import.meta.url,
    memo: {
      include: ["src/**", "ui/**", "vite.config.ts"],
    },
  },
  Effect.gen(function* () {
    const gateway = yield* AI.SessionSockets;
    const api = yield* HttpRouter.toHttpEffect(yield* orgRoutes);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://local").pathname;
        if (path.startsWith("/attach/")) {
          const [, , term, ...rest] = path.split("/");
          if (!term || rest.length === 0) {
            return HttpServerResponse.text("bad attach path", {
              status: 400,
            });
          }
          return yield* gateway.attach(
            decodeURIComponent(term),
            rest.map(decodeURIComponent).join("/"),
            request,
          );
        }
        return yield* api;
      }),
    };
  }).pipe(Effect.provide(Org)),
) {}
