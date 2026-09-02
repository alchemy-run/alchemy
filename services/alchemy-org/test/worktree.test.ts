/**
 * The sandbox-as-worktree contract: the session image ships with the
 * repo BAKED IN (`src/SandboxMicrovm.ts` / `src/Sandbox.ts` — a real
 * clone, `.git` and all), and a session treats that tree as its
 * branch: the tools see it, `Git.Checkouts` ADOPTS it instead of
 * re-deriving, sessions are isolated (one tree per sandbox), and the
 * work leaves through the publish pair (`pushBranch` →
 * `openPullRequest`) against the tree's own origin.
 *
 * The local tests are hermetic (bare origins on the host tmp dir —
 * the "bake" is simulated by a plain clone, exactly what the image
 * build produces). The publish test drives the REAL tool
 * implementations against the live `alchemy-run/test-alchemy` sandbox
 * repo and needs `GITHUB_TOKEN`:
 *
 *   doppler run -p alchemy-v2 -c dev -- bun test test/worktree.test.ts
 */
import { BunServices } from "@effect/platform-bun";
import { expect, test } from "bun:test";
import * as AI from "alchemy/AI";
import { SandboxLocal } from "alchemy/AI";
import * as Git from "alchemy/Git";
import * as GitHub from "alchemy/GitHub";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { fixed as workspace } from "alchemy/Workspace";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { ArtifactsLocal } from "../src/lib/ArtifactsLocal.ts";
import { testAlchemy } from "../src/Repos.ts";
import { Approvals } from "../src/services/Approvals.ts";
import { CheckoutsSandbox } from "../src/services/CheckoutsSandbox.ts";
import {
  Bash,
  BashLive,
  OpenPullRequest,
  OpenPullRequestLive,
  PublishToken,
  PushBranch,
  PushBranchLive,
  ReadOutputLive,
} from "../src/tools/index.ts";

const run = <A, E>(program: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
      Effect.scoped,
    ) as Effect.Effect<A, E>,
  );

/** A host-side sandbox rooted at `root` — the setup rig AND the exact
 *  physics a session's tools run over. */
const sandboxAt = (root: string) =>
  AI.makeSandboxLocal.pipe(Effect.provide(workspace(root)));

/** Deterministic commit identity for test commits. */
const IDENT = [
  "-c",
  "user.email=org@test.invalid",
  "-c",
  "user.name=alchemy-org-test",
];

const execIn =
  (sandbox: AI.Sandbox["Service"]) =>
  (command: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const result = yield* sandbox.exec(command, args, { timeout: 60_000 });
      if (!result.success) {
        return yield* Effect.fail(
          `${command} ${args.join(" ")} (exit ${result.exitCode}):\n${result.stderr}`,
        );
      }
      return result.stdout.trim();
    });

/** Create a bare origin at `<root>/<name>.git` seeded with `files` on
 *  `main`, and return its clone URL (an absolute path). */
const seedOrigin = (
  root: string,
  sh: ReturnType<typeof execIn>,
  sandbox: AI.Sandbox["Service"],
  name: string,
  files: Record<string, string>,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const url = path.join(root, `${name}.git`);
    const seed = `${name}-seed`;
    yield* sh("git", ["init", "--bare", "-b", "main", `${name}.git`]);
    yield* sh("git", ["clone", url, seed]);
    for (const [file, content] of Object.entries(files)) {
      yield* sandbox.writeFile(`${seed}/${file}`, content).pipe(Effect.orDie);
    }
    yield* sh("git", ["-C", seed, "checkout", "-B", "main"]);
    yield* sh("git", ["-C", seed, "add", "-A"]);
    yield* sh("git", ["-C", seed, ...IDENT, "commit", "-m", "init"]);
    yield* sh("git", ["-C", seed, "push", "origin", "main"]);
    return url;
  });

/** One SESSION's layer stack over its own tree — the org toolbox
 *  shape: workspace-rooted sandbox, bash + spill, checkouts. */
const sessionLayers = (root: string) => {
  const Ws = workspace(root);
  const Box = SandboxLocal.pipe(Layer.provide(Ws));
  const Support = Layer.mergeAll(Ws, Box, ArtifactsLocal);
  return Layer.mergeAll(
    Support,
    Layer.mergeAll(BashLive, ReadOutputLive).pipe(Layer.provide(Support)),
    CheckoutsSandbox.pipe(Layer.provide(Support)),
    RuntimeContext.phantom,
  );
};

test(
  "the baked tree surfaces through the tools and Checkouts ADOPTS it",
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "org-worktree-",
        });
        const host = yield* sandboxAt(root);
        const sh = execIn(host);
        const originUrl = yield* seedOrigin(root, sh, host, "origin", {
          "README.md": "BAKED-SENTINEL\n",
        });
        // the "image bake": a plain clone, `.git` and all
        yield* sh("git", ["clone", originUrl, "tree-a"]);
        const treeA = path.join(root, "tree-a");

        yield* Effect.gen(function* () {
          // (1) the tree surfaces through the agent's tools
          const bash = yield* Bash;
          const status = (yield* (bash as any)({
            command: "git status --porcelain=v1",
          })) as string;
          expect(status).toContain("exit: 0");
          const head = (yield* (bash as any)({
            command: "git rev-parse --abbrev-ref HEAD",
          })) as string;
          expect(head).toContain("main");

          // (2) checkout ADOPTS the bake: no wipe, no re-clone
          const checkouts = yield* Git.Checkouts;
          const co = yield* checkouts.checkout({
            key: "session-a",
            remote: { url: originUrl },
          });
          expect(co.branch).toBe("main");
          const sandbox = yield* AI.Sandbox;
          expect(yield* sandbox.readFile("README.md")).toContain(
            "BAKED-SENTINEL",
          );
          expect(yield* sandbox.exists(".alchemy-workspace.json")).toBe(true);
          // adopted in place — the bake's FULL history, never shallowed
          expect(yield* sandbox.exists(".git/shallow")).toBe(false);

          // (3) key addressing stays honest: one tree per sandbox
          expect(Option.isSome(yield* checkouts.get("session-a"))).toBe(true);
          expect(Option.isNone(yield* checkouts.get("session-b"))).toBe(true);
          const conflict = yield* checkouts
            .checkout({ key: "session-b", remote: { url: originUrl } })
            .pipe(Effect.flip);
          expect(String(conflict)).toContain("already holds");
        }).pipe(Effect.provide(sessionLayers(treeA)));
      }),
    ),
  60_000,
);

test(
  "a bake for a DIFFERENT repo is REPOINTED and converged in place, not wiped",
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "org-worktree-",
        });
        const host = yield* sandboxAt(root);
        const sh = execIn(host);
        const bakedUrl = yield* seedOrigin(root, sh, host, "baked", {
          "README.md": "BAKED-SENTINEL\n",
          ".gitignore": "node_modules\n",
        });
        const otherUrl = yield* seedOrigin(root, sh, host, "other", {
          "proof.txt": "OTHER-REPO\n",
          ".gitignore": "node_modules\n",
        });
        yield* sh("git", ["clone", bakedUrl, "tree"]);
        const tree = path.join(root, "tree");
        // the bake's prewarm: ignored installs that must survive the
        // repoint (the old wipe-and-reclone threw them away — and blew
        // its exec budget doing so on a real 1.2GB bake)
        yield* fs.makeDirectory(path.join(tree, "node_modules"));
        yield* fs.writeFileString(
          path.join(tree, "node_modules", "warm.txt"),
          "WARM\n",
        );

        yield* Effect.gen(function* () {
          const checkouts = yield* Git.Checkouts;
          const co = yield* checkouts.checkout({
            key: "review-1",
            remote: { url: otherUrl },
          });
          expect(co.branch).toBe("main");
          const sandbox = yield* AI.Sandbox;
          // the foreign bake's tracked content is gone; the requested
          // tree is in place, on a branch, with origin REPOINTED
          expect(yield* sandbox.exists("README.md")).toBe(false);
          expect(yield* sandbox.readFile("proof.txt")).toContain("OTHER-REPO");
          const origin = yield* sandbox.exec("git", ["remote", "get-url", "origin"]);
          expect(origin.stdout.trim()).toBe(otherUrl);
          const head = yield* sandbox.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
          expect(head.stdout.trim()).toBe("main");
          // ignored prewarm survives the converge
          expect(yield* sandbox.exists("node_modules/warm.txt")).toBe(true);
        }).pipe(Effect.provide(sessionLayers(tree)));
      }),
    ),
  60_000,
);

test(
  "sessions are ISOLATED: branches and files never leak across trees",
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "org-worktree-",
        });
        const host = yield* sandboxAt(root);
        const sh = execIn(host);
        const originUrl = yield* seedOrigin(root, sh, host, "origin", {
          "README.md": "BAKED-SENTINEL\n",
        });
        // two sessions, two machines: each gets its OWN copy of the bake
        yield* sh("git", ["clone", originUrl, "tree-a"]);
        yield* sh("git", ["clone", originUrl, "tree-b"]);

        // session A branches, writes, commits — all through its tools
        yield* Effect.gen(function* () {
          const bash = yield* Bash;
          const sandbox = yield* AI.Sandbox;
          expect(
            (yield* (bash as any)({
              command: "git switch -c agent/feature-a",
            })) as string,
          ).toContain("exit: 0");
          yield* sandbox
            .writeFile("feature.txt", "session A's work\n")
            .pipe(Effect.orDie);
          expect(
            (yield* (bash as any)({
              command: `git add -A && git ${IDENT.join(" ")} commit -m "feat: session A"`,
            })) as string,
          ).toContain("exit: 0");
        }).pipe(Effect.provide(sessionLayers(path.join(root, "tree-a"))));

        // session B sees NONE of it
        yield* Effect.gen(function* () {
          const bash = yield* Bash;
          const sandbox = yield* AI.Sandbox;
          const branches = (yield* (bash as any)({
            command: "git branch --list 'agent/*'",
          })) as string;
          expect(branches).not.toContain("agent/feature-a");
          expect(yield* sandbox.exists("feature.txt")).toBe(false);
        }).pipe(Effect.provide(sessionLayers(path.join(root, "tree-b"))));
      }),
    ),
  60_000,
);

// ---------------------------------------------------------------------------
// LIVE: the publish pair against the real sandbox repo. The tree is a
// clone of `alchemy-run/test-alchemy` (exactly the baked-image shape);
// the REAL `PushBranchLive` / `OpenPullRequestLive` implementations
// run over it — only the token minting (a deploy-time resource) and
// the approval gate are provided from the environment.
// ---------------------------------------------------------------------------

const LIVE_TOKEN = process.env.GITHUB_TOKEN;
// derived from the Repository resource — no repo-name literals
const REPO_IDENTITY = GitHub.repositoryIdentity(testAlchemy)!;
const REPO = `${REPO_IDENTITY.owner}/${REPO_IDENTITY.repository}`;
const BRANCH = "test/worktree-publish";

const gh = (pathname: string, init?: { method?: string; body?: unknown }) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.make(
      (init?.method ?? "GET") as "GET",
    )(`https://api.github.com/repos/${REPO}${pathname}`).pipe(
      HttpClientRequest.setHeaders({
        accept: "application/vnd.github+json",
        authorization: `Bearer ${LIVE_TOKEN}`,
        "user-agent": "alchemy-org-worktree-test",
      }),
      init?.body !== undefined
        ? HttpClientRequest.bodyJsonUnsafe(init.body)
        : (r) => r,
    );
    const response = yield* client.execute(request);
    const json = yield* response.json.pipe(
      Effect.orElseSucceed(() => undefined),
    );
    return { status: response.status, json };
  }).pipe(Effect.mapError((error) => `github api: ${String(error)}`));

/** Idempotent: close any open PR from a previous run, delete the branch. */
const cleanupRemote = Effect.gen(function* () {
  const owner = REPO.split("/")[0]!;
  const prs = yield* gh(`/pulls?head=${owner}:${BRANCH}&state=open`);
  for (const pr of (prs.json as Array<{ number: number }>) ?? []) {
    yield* gh(`/pulls/${pr.number}`, {
      method: "PATCH",
      body: { state: "closed" },
    });
  }
  yield* gh(`/git/refs/heads/${BRANCH}`, { method: "DELETE" });
}).pipe(Effect.ignore);

test.skipIf(!LIVE_TOKEN)(
  "the worktree PUBLISHES through the real tools: pushBranch → openPullRequest (live)",
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "org-worktree-live-",
        });
        const host = yield* sandboxAt(root);
        const sh = execIn(host);
        yield* cleanupRemote;
        // the baked-image shape: a real clone with its origin intact
        yield* sh("git", ["clone", GitHub.remote(testAlchemy).url, "tree"]);
        const tree = path.join(root, "tree");

        const Publish = Layer.mergeAll(
          PushBranchLive,
          OpenPullRequestLive,
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              SandboxLocal.pipe(Layer.provide(workspace(tree))),
              // pushBranch's push-URL credential
              Layer.succeed(
                PublishToken,
                Effect.succeed(Redacted.make(LIVE_TOKEN!)),
              ),
              // openPullRequest's binding: the REAL octokit operation
              // off ambient credentials (no PersonalAccessToken
              // resource — the deploy-time half of the Http impl)
              GitHub.CreatePullRequestLocal.pipe(
                Layer.provide(GitHub.fromToken(LIVE_TOKEN!)),
              ),
              Layer.succeed(Approvals, {
                ask: () => Effect.succeed("allowed-once" as const),
                pending: () => Effect.succeed([]),
                answer: () => Effect.succeed(false),
              }),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          // branch + commit through the session's own physics
          const bash = yield* Bash;
          const sandbox = yield* AI.Sandbox;
          expect(
            (yield* (bash as any)({
              command: `git switch -c ${BRANCH}`,
            })) as string,
          ).toContain("exit: 0");
          yield* sandbox
            .writeFile(
              "worktree-proof.txt",
              `published from the sandbox worktree: ${crypto.randomUUID()}\n`,
            )
            .pipe(Effect.orDie);
          expect(
            (yield* (bash as any)({
              command: `git add -A && git ${IDENT.join(" ")} commit -m "test: worktree publish"`,
            })) as string,
          ).toContain("exit: 0");

          // the REAL pushBranch tool — token rides the push URL
          const push = yield* PushBranch;
          const pushed = (yield* (push as any)({ branch: BRANCH })) as string;
          expect(pushed).toContain(`pushed HEAD to ${REPO}@${BRANCH}`);

          // out-of-band: the branch exists on the remote
          const ref = yield* gh(`/git/ref/heads/${encodeURIComponent(BRANCH)}`);
          expect(ref.status).toBe(200);

          // the REAL openPullRequest tool (approval gate answered)
          const open = yield* OpenPullRequest;
          const opened = (yield* (open as any)({
            head: BRANCH,
            base: "main",
            title: "test: sandbox worktree publish",
            body: "Automated worktree publish test — closed by the test itself.",
          }).pipe(
            Effect.provideService(AI.Thread, {
              key: "worktree-publish-test",
            } as unknown as AI.Thread["Service"]),
          )) as string;
          expect(opened).toMatch(/opened pull request #\d+/);

          // out-of-band: the PR is real — then close it and delete the ref
          const number = Number(/#(\d+)/.exec(opened)![1]);
          const pr = yield* gh(`/pulls/${number}`);
          expect(pr.status).toBe(200);
          expect((pr.json as { state?: string }).state).toBe("open");
        }).pipe(
          Effect.provide(
            Layer.mergeAll(Publish, sessionLayers(tree)),
          ),
          Effect.ensuring(cleanupRemote),
        );
      }),
    ),
  180_000,
);
