import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import { SessionRepo } from "../github/SessionRepo.ts";
import { primary } from "../github/Repos.ts";
import { ROOT } from "../Root.ts";
import { WORKSPACE_TERM, pullWorkspaceName, workspaceKey } from "./Keys.ts";
import { WorkspaceAgent } from "./WorkspaceAgent.ts";

/**
 * The WORKSPACE tools — how the company's agents provision and retire
 * the machines they work in. A workspace is an isolated machine with
 * the repository checked out (its own MicroVM deployed, a linked
 * worktree in dev — sandbox/WorkspaceAgent.ts); the tool RESULT names
 * it, and the Root Thread renders the name as the workspace's terminal
 * chip. Shared by the Head and the Manager.
 */

export class BadRef extends Data.TaggedError("BadRef")<{
  message: string;
}> {}

export class CheckoutFailed extends Data.TaggedError("CheckoutFailed")<{
  message: string;
}> {}

const wsName = AI.Thing("name", S.String)`
  The workspace's name ("pr-832", "scratch") — how every agent
  addresses it in paths ("@<name>/<path>") and how spawn hands it to
  an engineer. Letters, digits, dots, dashes, underscores.`;

const wsRef = AI.Thing("ref", S.optionalKey(S.String))`
  A pull request — "owner/repo#N" — to base the workspace on: its head
  branch, fetched fresh, named "pr-N". Omit for a scratch workspace on
  the repository's default state (name required then).`;

const branch = AI.Thing("branch", S.String)`
  The branch the workspace's tree has checked out.`;

export const makeWorkspaceTools = Effect.gen(function* () {
  const workspaces = yield* WorkspaceAgent;
  const sessions = yield* AI.Sessions;
  const sessionRepo = yield* SessionRepo;

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
    state. Answers ${AI.out(wsName, branch)}. Every agent reaches
    every workspace ("@<name>/<path>" in any path); an engineer is
    handed its DEFAULT one at spawn. Fails with ${BadRef} for a ref
    that is not a pull request of a connected repository,
    ${CheckoutFailed} when git refuses.`(
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

  const dropWorkspace = yield* AI.Tool("drop_workspace")`
    Drop the workspace named ${wsName} — its tree and its machine.
    Work committed and pushed survives on GitHub; anything else in the
    tree is gone. Engineers whose default it was lose their footing —
    stop or re-point them first. Fails with ${CheckoutFailed} when the
    release refuses.`(
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
    }),
  );

  return { workspace, dropWorkspace, provision, provisionPull };
});
