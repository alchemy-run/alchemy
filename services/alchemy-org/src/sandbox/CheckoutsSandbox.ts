import * as AI from "alchemy/AI";
import * as Git from "alchemy/Git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

const MARKER = ".alchemy-workspace.json";

interface Marker {
  readonly key: string;
  readonly branch: string;
  readonly remote: Git.Remote;
}

/**
 * `Git.Checkouts` over the session {@link AI.Sandbox} — the checkout
 * capability for placements whose driver has no filesystem (a session
 * Durable Object): git runs INSIDE the session's own sandbox machine
 * (the container image carries git), and the sandbox's workspace root
 * IS the tree.
 *
 * One tree per sandbox by construction: sessions map 1:1 to sandboxes
 * (`SandboxContainer` attaches one container per session DO), so the
 * key does not need to address among trees — it is recorded in a
 * marker file and verified on `get`, which keeps the contract's
 * key-addressing honest while the tools keep repo-relative paths
 * (exactly the local `Workspace.perRun` reading experience).
 *
 * The image may ship with a BAKED clone (`SandboxMicrovm.ts` /
 * `SandboxContainer.ts` bake the org repo, `.git` and all): when the requested
 * remote matches the bake's origin, the bake IS the worktree and is
 * adopted in place — full history, warm installs, zero clone. A bake
 * for a different repo is prewarm content, not a claimed tree: it is
 * reset and the requested tree derived greenfield.
 *
 * `release` empties the tree (the machine itself is recycled by
 * `sleepAfter`); public remotes only for now — the org's sandbox repo
 * is public, and pushes are not part of the review pipeline.
 */
export const CheckoutsSandbox = Layer.effect(
  Git.Checkouts,
  Effect.gen(function* () {
    const sandbox = yield* AI.Sandbox;

    /** Run one git command in the tree root; failures become GitError. */
    const git = (args: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const result = yield* sandbox
          .exec("git", args, { timeout: 120_000 })
          .pipe(
            Effect.mapError(
              (error) =>
                new Git.GitError({
                  command: args.join(" "),
                  exitCode: -1,
                  stderr: String(error),
                }),
            ),
          );
        if (!result.success) {
          return yield* Effect.fail(
            new Git.GitError({
              command: args.join(" "),
              exitCode: result.exitCode,
              stderr: result.stderr,
            }),
          );
        }
        return result.stdout;
      });

    /** The tree's identity, when one has been derived: a missing or
     *  unreadable marker is None — greenfield. */
    const readMarker: Effect.Effect<Option.Option<Marker>> = sandbox
      .readFile(MARKER)
      .pipe(
        Effect.flatMap((text) => Effect.try(() => JSON.parse(text) as Marker)),
        Effect.option,
      );

    const writeMarker = (marker: Marker) =>
      sandbox.writeFile(MARKER, JSON.stringify(marker)).pipe(Effect.orDie);

    const checkout = (marker: Marker): Git.Checkout => ({
      key: marker.key,
      root: "/workspace",
      path: ".",
      branch: marker.branch,
      remote: marker.remote,
    });

    /** Empty the tree — everything including dotfiles. A baked
     *  image's tree is GBs of installed repo (node_modules included):
     *  `rm -rf` the top-level entries (one exec per subtree beats
     *  `find -delete`'s per-inode unlink walk) under a generous
     *  budget. STRICT — a half-emptied tree left the baked workspace
     *  behind as untracked debris inside the freshly derived repo, so
     *  a failure here must fail the claim, not litter it. */
    const emptyTree = sandbox
      .exec(
        "find",
        [
          ".",
          "-mindepth",
          "1",
          "-maxdepth",
          "1",
          "-exec",
          "rm",
          "-rf",
          "{}",
          "+",
        ],
        { timeout: 300_000 },
      )
      .pipe(
        Effect.mapError(
          (error) =>
            new Git.GitError({
              command: "emptyTree",
              exitCode: -1,
              stderr: String(error),
            }),
        ),
        Effect.filterOrFail(
          (result) => result.success,
          (result) =>
            new Git.GitError({
              command: "emptyTree",
              exitCode: result.exitCode,
              stderr: result.stderr,
            }),
        ),
        Effect.asVoid,
      );

    /** Clone-URL identity: scheme/`.git`-suffix/trailing-slash agnostic. */
    const sameRemote = (a: string, b: string) => {
      const normalize = (url: string) =>
        url
          .trim()
          .replace(/^git@([^:]+):/, "https://$1/")
          .replace(/\.git$/, "")
          .replace(/\/+$/, "")
          .toLowerCase();
      return normalize(a) === normalize(b);
    };

    /** The tree's baked origin, when the image shipped with a clone
     *  (`SandboxMicrovm.ts` / `SandboxContainer.ts` bake the repo, `.git` and
     *  all). None when the tree is not a git repository. */
    const bakedOrigin = git(["remote", "get-url", "origin"]).pipe(
      Effect.map((url) => url.trim()),
      Effect.option,
    );

    return {
      checkout: (options) =>
        Effect.gen(function* () {
          const ref = options.ref ?? Git.defaultBranch(options.remote);
          const current = Option.getOrUndefined(yield* readMarker);

          // Land on the REAL branch (`main` unless the caller pins a
          // ref), tracking origin — the machine is the session's own
          // isolated sandbox, so there is no detached-worktree dance:
          // `git status` in a fresh session reads like a normal clone.
          const landOnBranch = Effect.gen(function* () {
            yield* git([
              "fetch",
              "--depth",
              "1",
              "origin",
              `+${ref}:refs/remotes/origin/${ref}`,
            ]);
            // --force: untracked leftovers from a torn reset must not
            // abort the checkout; -B (re)points the local branch at
            // the fetched tip and sets up tracking
            yield* git(["checkout", "--force", "-B", ref, `origin/${ref}`]);
            yield* git(["reset", "--hard", `origin/${ref}`]);
          });

          if (current !== undefined && current.key === options.key) {
            if (options.fresh !== true) return checkout(current);
            // re-derive the SAME tree from the remote as it is now
            yield* landOnBranch;
            const marker: Marker = {
              key: options.key,
              branch: ref,
              remote: options.remote,
            };
            yield* writeMarker(marker);
            return checkout(marker);
          }
          if (current !== undefined) {
            // one tree per sandbox — a second key is a composition bug
            return yield* Effect.fail(
              new Git.GitError({
                command: "checkout",
                exitCode: -1,
                stderr: `sandbox tree already holds '${current.key}' — one workspace per session sandbox`,
              }),
            );
          }

          // no marker: the tree may still carry the image's BAKED clone
          const baked = Option.getOrUndefined(yield* bakedOrigin);
          if (baked !== undefined) {
            if (sameRemote(baked, options.remote.url)) {
              // the bake IS the worktree: adopt it in place — full
              // history, remote intact, node_modules warm. The baked
              // branch is a build-time snapshot (whatever the host had
              // checked out); converge onto the requested branch when
              // it differs (or `fresh` demands the tip).
              const head = yield* git([
                "rev-parse",
                "--abbrev-ref",
                "HEAD",
              ]).pipe(Effect.orElseSucceed(() => ""));
              if (head.trim() !== ref || options.fresh === true) {
                yield* landOnBranch;
              }
              const marker: Marker = {
                key: options.key,
                branch: ref,
                remote: options.remote,
              };
              yield* writeMarker(marker);
              return checkout(marker);
            }
            // A bake for a DIFFERENT remote: REPOINT and converge in
            // place, never wipe. git makes the tracked tree match the
            // fetched tip whatever remote the objects came from —
            // `reset --hard` rewrites every path that differs, `clean
            // -fd` drops the old repo's untracked leftovers while the
            // ignored prewarm (node_modules, lib/, the pnpm store) stays
            // warm. The org's connected repos (`alchemy`, its
            // `test-alchemy` sandbox) share one codebase, so this is a
            // small delta; for an unrelated repo it is a full rewrite,
            // which is still correct. The old path — `rm -rf` the
            // whole 1.2GB bake and re-clone — blew its exec budget
            // partway through and left the session in a half-deleted
            // tree with no `.git`.
            yield* git(["remote", "set-url", "origin", options.remote.url]);
            yield* landOnBranch;
            yield* git(["clean", "-fd"]);
            const marker: Marker = {
              key: options.key,
              branch: ref,
              remote: options.remote,
            };
            yield* writeMarker(marker);
            return checkout(marker);
          }

          // greenfield: derive the tree in place (shallow — the ref's
          // tip is what a session starts from). The remote falls back
          // to set-url so a leftover origin from a torn reset converges
          // instead of crashing the whole session INIT.
          yield* git(["init", "."]);
          yield* git(["remote", "add", "origin", options.remote.url]).pipe(
            Effect.catch(() =>
              git(["remote", "set-url", "origin", options.remote.url]),
            ),
          );
          yield* landOnBranch;
          const marker: Marker = {
            key: options.key,
            branch: ref,
            remote: options.remote,
          };
          yield* writeMarker(marker);
          return checkout(marker);
        }),

      get: (key) =>
        readMarker.pipe(
          Effect.map((found) =>
            found.pipe(
              Option.filter((marker) => marker.key === key),
              Option.map(checkout),
            ),
          ),
        ),

      release: () => emptyTree,
    };
  }),
);
