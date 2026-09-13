import * as AI from "alchemy/AI";
import * as Git from "alchemy/Git";
import * as PersistentRef from "alchemy/PersistentRef";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SessionRepo, sessionOf } from "../github/SessionRepo.ts";
import { workspaceKey, workspaceName } from "../thread/Terms.ts";
import { defaultWorkspace } from "./SessionTree.ts";

/**
 * The session's view of its WORKSPACES — `AI.Sandbox` as a ROUTER over
 * the session's whole bag of them, not one machine with one cwd.
 *
 * A thread's agents (the manager and every engineer) share one view:
 * every workspace of the thread, all of them readable, writable, and
 * executable by all of them. A path addresses a sibling workspace
 * explicitly as `@<name>/…` (`@pr-1522/packages/alchemy`); a plain
 * relative path resolves in the session's DEFAULT workspace (the name
 * the manager handed it — `SessionTree.defaultWorkspace`). Which
 * machine that touches is the router's business: in dev every
 * workspace is a linked worktree on the ONE host server; deployed each
 * workspace is its OWN MicroVM, and the call is routed by re-keying
 * the machine derivation (`AI.Thread` override) before it reaches the
 * raw sandbox layer.
 *
 * FAIL-CLOSED, by construction: a session with no default workspace
 * and no `@name` in the path gets a typed error naming the fix; an
 * unknown workspace name fails the same way. There is NO fallback to
 * a machine root — the class of incident where a session's failed
 * checkout dropped its git commands into the developer's own tree
 * cannot type-check its way back in.
 *
 * STANDALONE sessions (`owner/repo/name`, `owner/repo#N` — the coder
 * product chats) keep their own physics: one implicit workspace
 * derived from the session key, CONVERGED ON FIRST TOUCH exactly as
 * before (the first call that reaches the tree lands the repository
 * on the machine; a failed converge is not memoized — the tool that
 * hit it fails with the model-visible reason and the next call tries
 * again).
 *
 * `Git.Checkouts` itself runs over the RAW sandbox (it is the
 * converge) — compose this layer OVER the pair, never under it.
 */
export const WorkspaceRouter: Layer.Layer<
  AI.Sandbox,
  never,
  AI.Sandbox | Git.Checkouts | SessionRepo
> = Layer.effect(
  AI.Sandbox,
  Effect.gen(function* () {
    const raw = yield* AI.Sandbox;
    const checkouts = yield* Git.Checkouts;
    const repo = yield* SessionRepo;

    /** Where a resolved call runs: under WHICH thread key (the machine
     *  address) and BELOW which path prefix on that machine. */
    interface Target {
      readonly key: string;
      /** The key differs from the calling session's — raw calls get a
       *  phantom `AI.Thread` so machine derivation lands right. */
      readonly override: boolean;
      readonly base: string | undefined;
    }

    /** The sandbox layer under us reads only `Thread.key` to derive
     *  the machine (documented on SandboxMicrovm/SandboxHttp). */
    const phantom = (key: string): AI.ThreadService => ({
      key,
      tokens: Effect.succeed(0),
      entries: Effect.succeed([]),
      compact: () => Effect.void,
      reply: () => Effect.void,
      remind: () => Effect.void,
      publish: () => Effect.void,
    });

    const inTarget =
      (target: Target) =>
      <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
        target.override
          ? Effect.provideService(effect, AI.Thread, phantom(target.key))
          : effect;

    /* ── workspace targets: looked up, never made ─────────────────── */

    /** Known workspace trees, per isolate. Positive-only: an absent
     *  workspace may be created a moment later. */
    const wsTrees = new Map<string, Git.Checkout>();

    const workspaceTarget = Effect.fn(function* (
      threadId: string,
      name: string,
    ) {
      const key = workspaceKey(threadId, name);
      const cached = wsTrees.get(key);
      if (cached !== undefined) {
        return {
          key,
          override: true,
          base: baseOf(cached),
        } satisfies Target;
      }
      const found = yield* checkouts
        .get(key)
        .pipe(Effect.provideService(AI.Thread, phantom(key)));
      if (Option.isNone(found)) {
        return yield* Effect.fail(
          `no workspace named '${name}' in this thread — the manager creates workspaces with its workspace tool; an existing sibling workspace is addressed as "@<name>/<path>"`,
        );
      }
      wsTrees.set(key, found.value);
      return {
        key,
        override: true,
        base: baseOf(found.value),
      } satisfies Target;
    });

    /* ── standalone sessions: converge on first touch (as before) ── */

    /** Converged standalone sessions → where their tree landed
     *  (`undefined`: the session's key names no repository). */
    const converged = new Map<string, Git.Checkout | undefined>();
    const inflight = new Map<
      string,
      Deferred.Deferred<Git.Checkout | undefined, string>
    >();

    /** Longest a caller waits on ANOTHER caller's in-flight converge —
     *  generous next to the slowest real one (a MicroVM waking plus a
     *  fresh PR fetch, under a minute). */
    const CONVERGE_WAIT = "5 minutes";

    const converge = Effect.fn(function* (session: string) {
      const tree = yield* repo.resolve(session);
      if (tree === undefined) return undefined;
      return yield* checkouts
        .checkout({
          key: session,
          remote: tree.remote,
          ...(tree.ref !== undefined ? { ref: tree.ref } : {}),
          fresh: tree.fresh,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              `the session's tree could not be checked out (${tree.repo}${
                tree.ref === undefined ? "" : ` @ ${tree.ref}`
              }): ${error.message}`,
          ),
        );
    });

    /** The standalone session's tree — memoized, deduped, bounded. */
    const standalone = Effect.fn(function* (sessionKey: string) {
      const session = sessionOf(sessionKey);
      if (converged.has(session)) return converged.get(session);
      const waiting = inflight.get(session);
      if (waiting !== undefined) {
        // Bounded: a converge whose fiber died with an abandoned
        // request (workerd drops its I/O — the fiber never settles)
        // must not hold every later caller hostage. Past the bound
        // the entry is forgotten so the NEXT call converges afresh.
        return yield* Deferred.await(waiting).pipe(
          Effect.timeoutOrElse({
            duration: CONVERGE_WAIT,
            orElse: () =>
              Effect.suspend(() => {
                if (inflight.get(session) === waiting) {
                  inflight.delete(session);
                }
                return Effect.fail(
                  "the session's tree checkout did not finish in time — try again",
                );
              }),
          }),
        );
      }
      const gate = yield* Deferred.make<Git.Checkout | undefined, string>();
      inflight.set(session, gate);
      return yield* converge(session).pipe(
        Effect.onExit((exit) =>
          Effect.suspend(() => {
            inflight.delete(session);
            if (Exit.isSuccess(exit)) {
              converged.set(session, exit.value);
              return Deferred.done(gate, exit);
            }
            // an interrupted converge (the caller went away mid-fetch)
            // releases its waiters to retry rather than hang them
            return Cause.hasInterruptsOnly(exit.cause)
              ? Deferred.fail(
                  gate,
                  "the session's tree checkout was interrupted — try again",
                )
              : Deferred.done(gate, exit);
          }),
        ),
      );
    });

    /* ── resolution ───────────────────────────────────────────────── */

    /** The session's DEFAULT workspace name (`SessionTree`), when its
     *  frame carries a store and the cell is set. */
    const handedName: Effect.Effect<string | undefined> = Effect.gen(
      function* () {
        const store = yield* Effect.serviceOption(PersistentRef.Store);
        if (Option.isNone(store)) return undefined;
        const name = yield* defaultWorkspace.pipe(
          Effect.provideService(PersistentRef.Store, store.value),
        );
        return name ?? undefined;
      },
    );

    /** The tree's path on the machine, when it is not the root. */
    const baseOf = (tree: Git.Checkout | undefined): string | undefined =>
      tree === undefined || tree.path === "." || tree.path === ""
        ? undefined
        : tree.path.replace(/\/+$/, "");

    /** `@name` / `@name/rest` — the explicit workspace address. */
    const parseAt = (
      path: string | undefined,
    ): { readonly name?: string; readonly rest?: string } => {
      if (path === undefined || !path.startsWith("@")) return { rest: path };
      const slash = path.indexOf("/");
      return slash === -1
        ? { name: path.slice(1) }
        : {
            name: path.slice(1, slash),
            rest: path.slice(slash + 1),
          };
    };

    const NO_WORKSPACE =
      "this session has no workspace: no default was handed to it and the path names none — address one explicitly as \"@<name>/<path>\" (the thread's manager creates workspaces with its workspace tool)";

    /** Resolve the machine+base a call with `explicit` (an `@name`, if
     *  any) runs against. */
    const resolve = Effect.fn(function* (explicit: string | undefined) {
      const thread = Option.getOrUndefined(
        yield* Effect.serviceOption(AI.Thread),
      );
      if (thread === undefined) {
        return yield* Effect.fail(
          "no session in scope — sandbox calls resolve their workspace from the calling session",
        );
      }
      const threadId = thread.key.split("::")[0]!;
      if (explicit !== undefined) {
        return yield* workspaceTarget(threadId, explicit);
      }
      // a workspace session works in ITS OWN tree
      const own = workspaceName(thread.key);
      if (own !== undefined) return yield* workspaceTarget(threadId, own);
      // a standalone (repo-keyed) session converges its implicit tree
      const tree = yield* standalone(thread.key);
      if (tree !== undefined) {
        return { key: thread.key, override: false, base: baseOf(tree) };
      }
      // thread-family: the handed default, or nothing — NEVER a root
      const name = yield* handedName;
      if (name !== undefined) return yield* workspaceTarget(threadId, name);
      return yield* Effect.fail(NO_WORKSPACE);
    });

    /** A tool's path, re-rooted at the target's tree. Absolute paths
     *  pass through — machine containment judges them (dev serves ONLY
     *  the workspaces directory; a MicroVM is its workspace). */
    const at = (base: string | undefined, path: string | undefined) => {
      if (base === undefined) return path;
      if (path === undefined || path === "" || path === ".") return base;
      if (path.startsWith("/")) return path;
      return `${base}/${path.replace(/^\.\//, "")}`;
    };

    /** Route one path-addressed call. */
    const routed = <A, E>(
      path: string | undefined,
      use: (path: string | undefined) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E | string> => {
      const { name, rest } = parseAt(path);
      return resolve(name).pipe(
        Effect.flatMap((target) =>
          inTarget(target)(use(at(target.base, rest))),
        ),
      );
    };

    /* ── the contract ─────────────────────────────────────────────── */

    // PTY calls resolve the session's OWN target (no `@` grammar: a
    // terminal is opened INTO a workspace by addressing that
    // workspace's session — the UI's per-workspace terminal — not by
    // steering a sibling's shell), so ids stay scoped to one machine
    // across open/stream/input/close.
    const ptyTarget = resolve(undefined);
    const pty: AI.SandboxPty | undefined =
      raw.pty === undefined
        ? undefined
        : {
            open: (id, cols, rows, cwd) =>
              ptyTarget.pipe(
                Effect.flatMap((target) =>
                  inTarget(target)(
                    raw.pty!.open(id, cols, rows, at(target.base, cwd)),
                  ),
                ),
              ),
            stream: (id) => raw.pty!.stream(id),
            input: (id, data) =>
              ptyTarget.pipe(
                Effect.flatMap((target) =>
                  inTarget(target)(raw.pty!.input(id, data)),
                ),
              ),
            resize: (id, cols, rows) =>
              ptyTarget.pipe(
                Effect.flatMap((target) =>
                  inTarget(target)(raw.pty!.resize(id, cols, rows)),
                ),
              ),
            close: (id) =>
              ptyTarget.pipe(
                Effect.flatMap((target) =>
                  inTarget(target)(raw.pty!.close(id))),
              ),
          };

    /** A REMOVED session's implicit tree goes with it (standalone
     *  sessions only — a thread's workspaces are released by their
     *  owner, the Workspace session, when the thread tears down).
     *  Contained like every lifecycle hook: hygiene never fails the
     *  removal. */
    const destroyTree: Effect.Effect<void> = Effect.gen(function* () {
      const thread = Option.getOrUndefined(
        yield* Effect.serviceOption(AI.Thread),
      );
      if (thread === undefined) return;
      if (workspaceName(thread.key) !== undefined) return;
      if ((yield* handedName) !== undefined) return;
      const session = sessionOf(thread.key);
      if (!converged.has(session)) return;
      const tree = yield* checkouts.get(session);
      if (Option.isSome(tree) && baseOf(tree.value) !== undefined) {
        yield* checkouts.release(session);
      }
      converged.delete(session);
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `dropping the session's tree failed (contained): ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      ),
    );

    const lifecycle: AI.SandboxLifecycle = {
      suspend: raw.lifecycle?.suspend ?? Effect.void,
      ...(raw.lifecycle?.resume !== undefined
        ? { resume: raw.lifecycle.resume }
        : {}),
      destroy: destroyTree.pipe(
        Effect.andThen(raw.lifecycle?.destroy ?? Effect.void),
      ),
    };

    return AI.Sandbox.of({
      exec: (command, args, options) => {
        const { name, rest } = parseAt(options?.cwd);
        return resolve(name).pipe(
          Effect.flatMap((target) =>
            inTarget(target)(
              raw.exec(command, args, {
                ...options,
                cwd: at(target.base, rest),
              }),
            ),
          ),
        );
      },
      readFile: (path) => routed(path, (p) => raw.readFile(p!)),
      writeFile: (path, content) =>
        routed(path, (p) => raw.writeFile(p!, content)),
      deleteFile: (path) => routed(path, (p) => raw.deleteFile(p!)),
      mkdir: (path) => routed(path, (p) => raw.mkdir(p!)),
      listFiles: (path) => routed(path, (p) => raw.listFiles(p)),
      exists: (path) => routed(path, (p) => raw.exists(p!)),
      ...(pty !== undefined ? { pty } : {}),
      lifecycle,
    });
  }),
);
