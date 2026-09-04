import * as AI from "alchemy/AI";
import * as Git from "alchemy/Git";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SessionRepo, sessionOf } from "../github/SessionRepo.ts";

/**
 * The session's tree, CONVERGED ON FIRST TOUCH — `AI.Sandbox` over the
 * machine, with one rule: the first call that reaches the tree (a tool
 * reading a file, a shell opening, an exec) first lands the session's
 * repository on it (`SessionRepo` says which; `Git.Checkouts` does it),
 * and every call after that goes straight through.
 *
 * This is what keeps a chat's ANSWER independent of the machine: the
 * charter's INIT no longer checks anything out (it used to — every
 * first message waited a minute for a VM to wake and a tree to
 * converge before the user's text was even durable). A reply that
 * needs no tool needs no machine; a tool that does shows the wait as
 * ITS running state, on its own card — the live `tool-call`
 * observation announces it the moment the model makes the call.
 *
 * Memoized per session, per isolate: the converge runs once and every
 * caller (threads, terminals, the spill store) awaits the same fiber; a
 * FAILED converge is not remembered — the tool that hit it fails with
 * the model-visible reason, and the next call tries again. Legacy keys
 * (`main`, `t-…`) resolve to no tree and touch the baked tree as is.
 *
 * The sandbox handed out IS the session's tree: when the checkout
 * lands somewhere other than the machine's root (`Git.Checkout.path`
 * — a worktree under `.alchemy/worktrees/…` on the dev host), every
 * call is re-rooted there: exec and the terminal start in it, and
 * tool paths resolve against it, so tools keep repo-relative paths
 * whatever the physics. A tree at `.` (the MicroVM, whose whole disk
 * is the tree) passes through untouched.
 *
 * `Git.Checkouts` itself runs over the RAW sandbox (it is the converge)
 * — compose this layer OVER the pair, never under it.
 */
/** Longest a caller waits on ANOTHER caller's in-flight converge —
 *  generous next to the slowest real one (a MicroVM waking plus a
 *  fresh PR fetch, under a minute). */
const CONVERGE_WAIT = "5 minutes";

export const SandboxCheckout: Layer.Layer<
  AI.Sandbox,
  never,
  AI.Sandbox | Git.Checkouts | SessionRepo
> = Layer.effect(
  AI.Sandbox,
  Effect.gen(function* () {
    const raw = yield* AI.Sandbox;
    const checkouts = yield* Git.Checkouts;
    const repo = yield* SessionRepo;

    /** Converged sessions → where their tree landed (`undefined`:
     *  no tree, the machine root as-is). */
    const converged = new Map<string, Git.Checkout | undefined>();
    const inflight = new Map<
      string,
      Deferred.Deferred<Git.Checkout | undefined, string>
    >();

    const converge = (
      session: string,
    ): Effect.Effect<Git.Checkout | undefined, string> =>
      Effect.gen(function* () {
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

    /** The tree is ready for `thread` (and where it is) — or the
     *  reason it is not. */
    const ready: Effect.Effect<Git.Checkout | undefined, string> = Effect.gen(
      function* () {
        const thread = Option.getOrUndefined(
          yield* Effect.serviceOption(AI.Thread),
        );
        // no session in scope (a worker-level probe): nothing to converge
        if (thread === undefined) return undefined;
        const session = sessionOf(thread.key);
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
      },
    );

    /** The tree's path on the machine, when it is not the root. */
    const baseOf = (tree: Git.Checkout | undefined): string | undefined =>
      tree === undefined || tree.path === "." || tree.path === ""
        ? undefined
        : tree.path.replace(/\/+$/, "");

    /** A tool's sandbox-relative path, re-rooted at the tree. Absolute
     *  paths pass through — containment judges them. */
    const at = (base: string | undefined, path: string | undefined) => {
      if (base === undefined) return path;
      if (path === undefined || path === "" || path === ".") return base;
      if (path.startsWith("/")) return path;
      return `${base}/${path.replace(/^\.\//, "")}`;
    };

    const then = <A, E>(
      use: (base: string | undefined) => Effect.Effect<A, E | string>,
    ) => ready.pipe(Effect.flatMap((tree) => use(baseOf(tree))));

    const pty: AI.SandboxPty | undefined =
      raw.pty === undefined
        ? undefined
        : {
            open: (id, cols, rows, cwd) =>
              then((base) => raw.pty!.open(id, cols, rows, at(base, cwd))),
            stream: raw.pty.stream,
            input: raw.pty.input,
            resize: raw.pty.resize,
            close: raw.pty.close,
          };

    /** A REMOVED session's tree goes with its machine. On a machine
     *  whose disk is the tree (the MicroVM) terminating it is enough;
     *  a tree that lives BESIDE the machine's root (a dev worktree)
     *  is dropped through `Git.Checkouts` first — and forgotten here,
     *  so a later session under the same key converges anew. Contained
     *  like every lifecycle hook: hygiene never fails the removal. */
    const destroyTree: Effect.Effect<void> = Effect.gen(function* () {
      const thread = Option.getOrUndefined(
        yield* Effect.serviceOption(AI.Thread),
      );
      if (thread === undefined) return;
      const session = sessionOf(thread.key);
      const tree = yield* checkouts.get(session);
      if (Option.isSome(tree) && baseOf(tree.value) !== undefined) {
        yield* checkouts.release(session);
      }
      converged.delete(session);
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          `dropping the session's tree failed (contained): ${error.message}`,
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
      exec: (command, args, options) =>
        then((base) =>
          raw.exec(
            command,
            args,
            base === undefined
              ? options
              : { ...options, cwd: at(base, options?.cwd) },
          ),
        ),
      readFile: (path) => then((base) => raw.readFile(at(base, path)!)),
      writeFile: (path, content) =>
        then((base) => raw.writeFile(at(base, path)!, content)),
      deleteFile: (path) => then((base) => raw.deleteFile(at(base, path)!)),
      mkdir: (path) => then((base) => raw.mkdir(at(base, path)!)),
      listFiles: (path) => then((base) => raw.listFiles(at(base, path))),
      exists: (path) => then((base) => raw.exists(at(base, path)!)),
      ...(pty !== undefined ? { pty } : {}),
      lifecycle,
    });
  }),
);
