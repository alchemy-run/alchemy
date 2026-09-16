import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { currentAsk } from "../chat/Ask.ts";
import { Posts } from "../chat/Posts.ts";
import { SessionRepo } from "../github/SessionRepo.ts";
import { primary } from "../github/Repos.ts";
import { ROOT } from "../Root.ts";
import { WORKSPACE_TERM, pullWorkspaceName, workspaceKey } from "./Keys.ts";
import { WorkspaceAgent } from "./WorkspaceAgent.ts";

/**
 * The WORKSPACE tools — how the company's agents provision, discover,
 * and retire the machines they work in. A workspace is an isolated
 * machine with the repository checked out (its own MicroVM deployed,
 * a linked worktree in dev — sandbox/WorkspaceAgent.ts).
 *
 * There is NO per-session default workspace: agents CREATE workspaces
 * as they need them, a workspace made inside a thread is LINKED to
 * that thread, and any agent can QUERY a thread's active workspaces —
 * then address one explicitly as `@<name>/<path>` in any tool path.
 */

export class BadRef extends Data.TaggedError("BadRef")<{
  message: string;
}> {}

export class CheckoutFailed extends Data.TaggedError("CheckoutFailed")<{
  message: string;
}> {}

const wsName = AI.Thing("name", S.String)`
  The workspace's name ("pr-832", "scratch") — how every agent
  addresses it in paths ("@<name>/<path>"). Letters, digits, dots,
  dashes, underscores.`;

const wsRef = AI.Thing("ref", S.optionalKey(S.String))`
  A pull request — "owner/repo#N" — to base the workspace on: its head
  branch, fetched fresh, named "pr-N". Omit for a scratch workspace on
  the repository's default state (name required then).`;

const branch = AI.Thing("branch", S.String)`
  The branch the workspace's tree has checked out.`;

const active = AI.Thing("workspaces", S.Array(S.String))`
  The workspaces active in this thread, oldest first — address one as
  "@<name>/<path>".`;

/** The THREAD the calling session is working in — the root of the
 *  message its round answers (undefined outside a conversation). */
const currentThreadRoot = Effect.gen(function* () {
  const frame = yield* Effect.serviceOption(AI.Thread);
  if (Option.isNone(frame)) return undefined;
  const parent = yield* currentAsk;
  if (parent === undefined) return undefined;
  const posts = yield* Effect.serviceOption(Posts);
  if (Option.isNone(posts)) return undefined;
  const above = yield* posts.value.ancestors(parent);
  return above[0]?.id ?? parent;
});

export const makeWorkspaceTools = Effect.gen(function* () {
  const workspaces = yield* WorkspaceAgent;
  const sessions = yield* AI.Sessions;
  const sessionRepo = yield* SessionRepo;
  const posts = yield* Effect.serviceOption(Posts);

  /** Creating a workspace inside a thread LINKS it there — that is
   *  how teammates' fresh sessions discover it. */
  const link = Effect.fn(function* (name: string) {
    const thread = yield* currentThreadRoot;
    if (thread === undefined || Option.isNone(posts)) return;
    yield* posts.value.linkWorkspace(thread, name).pipe(Effect.ignore);
  });

  /** Provision one workspace (its own machine + tree). Idempotent. */
  const provision = Effect.fn(function* (options: {
    readonly name: string;
    readonly remote: string;
    readonly ref?: string;
    readonly fresh?: boolean;
  }) {
    if (!/^[a-zA-Z0-9._-]+$/.test(options.name)) {
      return yield* Effect.fail(
        new BadRef({
          message: `'${options.name}' is not a workspace name — letters, digits, dots, dashes, underscores`,
        }),
      );
    }
    const made = yield* workspaces
      .at(workspaceKey(ROOT, options.name))
      .provision({
        remote: options.remote,
        ...(options.ref !== undefined ? { ref: options.ref } : {}),
        ...(options.fresh !== undefined ? { fresh: options.fresh } : {}),
      })
      .pipe(
        Effect.mapError(
          (message) => new CheckoutFailed({ message: String(message) }),
        ),
      );
    yield* link(made.name);
    return made;
  });

  /** The workspace for a pull request — made or found, named `pr-N`. */
  const provisionPull = Effect.fn(function* (ref: string) {
    const tree = yield* sessionRepo
      .resolve(ref)
      .pipe(Effect.mapError((message) => new BadRef({ message })));
    if (tree === undefined || tree.pull === undefined) {
      return yield* Effect.fail(
        new BadRef({
          message: `${ref} is not a pull request of a connected repository`,
        }),
      );
    }
    return yield* provision({
      name: pullWorkspaceName(tree.pull.number),
      remote: tree.remote.url,
      ref: tree.pull.ref,
      fresh: true,
    });
  });

  const workspace = yield* AI.Tool("workspace")`
    Ensure a WORKSPACE — an isolated machine with the repository
    checked out, ready to be worked on. With ${wsRef}: the pull
    request's head branch, fetched fresh, named "pr-N". Without: a
    scratch workspace named ${wsName} on the repository's default
    state. Answers ${AI.out(wsName, branch)}. Created inside a
    thread, the workspace is LINKED to it — teammates find it with
    list_workspaces. There are no defaults: every agent addresses
    every workspace explicitly ("@<name>/<path>" in any path). Fails
    with ${BadRef} for a ref that is not a pull request of a
    connected repository, ${CheckoutFailed} when git refuses.`(
    Effect.fn(function* (p: { ref?: string; name?: string }) {
      if (p.ref !== undefined) {
        const made = yield* provisionPull(p.ref);
        return { name: made.name, branch: made.branch };
      }
      if (p.name === undefined) {
        return yield* Effect.fail(
          new BadRef({ message: "a workspace needs a ref or a name" }),
        );
      }
      const made = yield* provision({
        name: p.name,
        remote: GitHub.remote(primary).url,
      });
      return { name: made.name, branch: made.branch };
    }),
  );

  const listWorkspaces = yield* AI.Tool("list_workspaces")`
    The workspaces ACTIVE in this thread — ${AI.out(active)}. You
    start from zero: this is how you find the machine the thread's
    work lives on before addressing paths ("@<name>/<path>"). Empty
    means nobody made one yet — create it with workspace if your
    work needs a tree.`(
    Effect.fn(function* () {
      const thread = yield* currentThreadRoot;
      if (thread === undefined || Option.isNone(posts)) {
        return { workspaces: [] };
      }
      return { workspaces: yield* posts.value.workspacesOf(thread) };
    }),
  );

  const dropWorkspace = yield* AI.Tool("drop_workspace")`
    Drop the workspace named ${wsName} — its tree and its machine.
    Work committed and pushed survives on GitHub; anything else in
    the tree is gone, and the name leaves every thread it was linked
    in. Fails with ${CheckoutFailed} when the release refuses.`(
    Effect.fn(function* (p: { name: string }) {
      const key = workspaceKey(ROOT, p.name);
      yield* workspaces
        .at(key)
        .release()
        .pipe(
          Effect.mapError(
            (message) => new CheckoutFailed({ message: String(message) }),
          ),
        );
      yield* sessions.remove(WORKSPACE_TERM, key, { machine: true });
      if (Option.isSome(posts)) {
        yield* posts.value.unlinkWorkspace(p.name).pipe(Effect.ignore);
      }
    }),
  );

  return {
    workspace,
    listWorkspaces,
    dropWorkspace,
    provision,
    provisionPull,
  };
});
