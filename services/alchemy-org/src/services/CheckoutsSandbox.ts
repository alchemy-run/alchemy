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
 * `release` empties the tree (the machine itself is recycled by
 * `sleepAfter`); public remotes only for now — the org's sandbox repo
 * is public, and pushes are not part of the review pipeline.
 */
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
        Effect.flatMap((text) =>
          Effect.try(() => JSON.parse(text) as Marker),
        ),
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

    /** Empty the tree — everything including dotfiles, best-effort. */
    const emptyTree = sandbox
      .exec("find", [".", "-mindepth", "1", "-delete"], { timeout: 60_000 })
      .pipe(Effect.ignore);

    return {
      checkout: (options) =>
        Effect.gen(function* () {
          const ref = options.ref ?? Git.defaultBranch(options.remote);
          const current = Option.getOrUndefined(yield* readMarker);

          if (current !== undefined && current.key === options.key) {
            if (options.fresh !== true) return checkout(current);
            // re-derive the SAME tree from the remote as it is now
            yield* git(["fetch", "--depth", "1", "origin", ref]);
            yield* git(["checkout", "--detach", "FETCH_HEAD"]);
            yield* git(["reset", "--hard", "FETCH_HEAD"]);
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

          // greenfield: derive the tree in place (shallow — the ref's
          // tip is what a review reads)
          yield* git(["init", "."]);
          yield* git(["remote", "add", "origin", options.remote.url]);
          yield* git(["fetch", "--depth", "1", "origin", ref]);
          yield* git(["checkout", "--detach", "FETCH_HEAD"]);
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
