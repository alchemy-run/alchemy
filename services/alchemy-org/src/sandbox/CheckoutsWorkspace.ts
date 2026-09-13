import * as Git from "alchemy/Git";
import { makeFetchRpcStub } from "alchemy/Rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { WorkspaceHostShape } from "./WorkspaceHost.ts";

/**
 * `Git.Checkouts` over the dev sandbox server's WORKSPACE VERBS — the
 * dev-mode pairing for `SandboxDev` (see SandboxSession.ts). Each
 * workspace is a linked worktree of the developer's repository under
 * `.alchemy/workspaces/<key>`, provisioned by `makeWorkspaceHost` IN
 * THE HOST PROCESS: the Worker calls three fixed RPC verbs
 * (`workspaceEnsure`/`workspaceGet`/`workspaceDrop`) and never execs
 * anything at the repository root — sessions structurally cannot reach
 * the developer's checkout (the served sandbox root IS the workspaces
 * directory).
 *
 * `Checkout.path` is relative to that served root (the workspace's
 * directory name), so it doubles as the WorkspaceRouter's path prefix.
 */
export const CheckoutsWorkspace = (
  url: Effect.Effect<string | undefined>,
): Layer.Layer<Git.Checkouts> =>
  Layer.effect(
    Git.Checkouts,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;

      const stubs = new Map<string, WorkspaceHostShape>();
      const stub: Effect.Effect<WorkspaceHostShape, Git.GitError> = Effect.gen(
        function* () {
          const base = yield* url;
          if (base === undefined || base.length === 0) {
            return yield* Effect.fail(
              new Git.GitError({
                command: "workspace rpc",
                exitCode: -1,
                stderr:
                  "the dev sandbox server address is not configured (no URL bound)",
              }),
            );
          }
          const baseUrl = base.replace(/\/+$/, "");
          const existing = stubs.get(baseUrl);
          if (existing !== undefined) return existing;
          const made = makeFetchRpcStub<WorkspaceHostShape>({
            baseUrl,
            fetch: (request) => client.execute(request),
          });
          stubs.set(baseUrl, made);
          return made;
        },
      );

      /** Verb errors cross the RPC as strings; the contract speaks
       *  `GitError`. */
      const asGitError = (verb: string) => (error: unknown) =>
        error instanceof Git.GitError
          ? error
          : new Git.GitError({
              command: verb,
              exitCode: -1,
              stderr: typeof error === "string" ? error : String(error),
            });

      const checkout = (
        key: string,
        remote: Git.Remote,
        tree: { root: string; path: string; branch: string; remote: string },
      ): Git.Checkout => ({
        key,
        root: tree.root,
        path: tree.path,
        branch: tree.branch,
        remote: remote.url.length > 0 ? remote : { url: tree.remote },
      });

      return {
        checkout: Effect.fn(function* ({ key, remote, ref, fresh }) {
          const host = yield* stub;
          const tree = yield* host
            .workspaceEnsure(key, {
              ...(ref !== undefined ? { ref } : {}),
              ...(fresh === true ? { fresh } : {}),
            })
            .pipe(Effect.mapError(asGitError(`workspaceEnsure ${key}`)));
          return checkout(key, remote, tree);
        }),
        get: Effect.fn(
          function* (key) {
            const host = yield* stub;
            const tree = yield* host
              .workspaceGet(key)
              .pipe(Effect.mapError(asGitError(`workspaceGet ${key}`)));
            if (tree === null) return Option.none<Git.Checkout>();
            return Option.some(checkout(key, { url: tree.remote }, tree));
          },
          Effect.option,
          Effect.map(Option.flatten),
        ),
        release: (key) =>
          stub.pipe(
            Effect.flatMap((host) => host.workspaceDrop(key)),
            Effect.mapError(asGitError(`workspaceDrop ${key}`)),
            Effect.asVoid,
          ),
      } satisfies Git.CheckoutsService;
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
