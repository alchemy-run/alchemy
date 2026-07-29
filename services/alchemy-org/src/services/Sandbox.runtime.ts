/**
 * The sandbox CONTAINER program — the org's local physics, verbatim,
 * running inside a Cloudflare Container: `tools/LocalToolbox.ts` over
 * `Git.WorkspacesWorktree`, exactly the layers the laptop composition
 * uses (the components doctrine made literal — the environment changed,
 * the provide-list did not).
 *
 * `call` dispatches one tool invocation to the run key's worktree: the
 * local tools resolve their root through `Workspace.perRun`, which
 * reads `AI.Thread.key` — here a per-call stub carrying ONLY the key,
 * the one member the workspace join uses.
 *
 * `push` is the git half of OpenPullRequest (branch → add → commit →
 * push); the GitHub API half (pulls.create, the ledger link) stays on
 * the Worker, which has the bindings.
 *
 * Credentials: ONE `GitHub.PersonalAccessToken` resource captured at
 * deploy and bound into the container's environment; clone and push
 * authenticate with the bound token, never a deploy-shell ambient.
 */
import * as AI from "alchemy/AI";
import * as Git from "alchemy/Git";
import * as GitHub from "alchemy/GitHub";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { perRun } from "alchemy/Workspace";
import * as Dockerfile from "alchemy/Docker/Dockerfile";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { runProcess } from "../lib/ProcessRunner.ts";
import { testAlchemy } from "../Repos.ts";
import {
  ApplyPatch,
  Bash,
  EditFile,
  Glob,
  Grep,
  ListDirectory,
  ReadFile,
  ReadOutput,
  WriteFile,
} from "../tools/index.ts";
import {
  ReadToolsLocal,
  RunToolsLocal,
  WriteToolsLocal,
} from "../tools/LocalToolbox.ts";
import { OrgSandbox } from "./Sandbox.ts";

/** The environment: Bun + git + ripgrep (the toolbox's two binaries). */
const image = Dockerfile.inline`FROM oven/bun:1.3
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates && rm -rf /var/lib/apt/lists/*
`;

/** The one member the workspace join reads is `key`; everything else
 *  a sandboxed tool could ask of a thread is honestly absent here. */
const threadStub = (key: string): AI.ThreadService => {
  const absent = Effect.die(
    "AI.Thread is not available inside the sandbox — tools may only use the run key",
  );
  return {
    key,
    tokens: absent,
    entries: absent,
    compact: () => absent,
    reply: () => absent,
    remind: () => absent,
  };
};

export default OrgSandbox.make(
  {
    main: import.meta.url,
    dockerfile: image,
    instanceType: "basic",
  },
  Effect.gen(function* () {
    // ── credentials: the PAT bound at deploy, read back at runtime ──
    const Token = yield* GitHub.PersonalAccessToken;
    const token = yield* Token("OrgSandboxGitHubToken", {});
    const value = yield* token.value;

    // PLAN stops here: the constructor also runs on the deploying
    // machine to collect the bindings above; the machine below —
    // worktrees under /workspaces, the toolbox layers — exists only
    // inside the container (the __ALCHEMY_RUNTIME__ doctrine)
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const plan = () =>
        Effect.die("the sandbox's methods only exist inside the container");
      return OrgSandbox.of({ call: plan, push: plan });
    }

    // the accessor resolves at container runtime; `unwrap` defers the
    // literal-token layer construction until then
    const Credentials = Layer.unwrap(Effect.map(value, GitHub.fromToken));

    const remote = GitHub.remote(testAlchemy);

    // ── the SAME layers the laptop runs, built once per container ──
    const Workspaces = Git.WorkspacesWorktree({ root: "/workspaces" }).pipe(
      Layer.provide(GitHub.GitCredentials),
      Layer.provide(Credentials),
    );
    const Toolbox = Layer.mergeAll(
      ReadToolsLocal,
      RunToolsLocal,
      WriteToolsLocal,
    ).pipe(
      Layer.provide(perRun({ remote })),
      Layer.provideMerge(Workspaces),
    );
    const built = yield* Layer.build(Toolbox).pipe(Effect.orDie);

    const tools = [
      Grep,
      Glob,
      ListDirectory,
      ReadFile,
      Bash,
      ReadOutput,
      EditFile,
      ApplyPatch,
      WriteFile,
    ] as const;
    const registry = new Map<
      string,
      (params: unknown) => Effect.Effect<unknown, unknown, unknown>
    >(
      tools.map((tag) => [
        tag["~alchemy/Name"] as string,
        Context.get(built, tag as never) as never,
      ]),
    );

    const workspaces = Context.get(built, Git.Workspaces);

    const git = (cwd: string, args: ReadonlyArray<string>) =>
      runProcess({
        command: "git",
        args: [
          "-c",
          "user.name=alchemy-org[bot]",
          "-c",
          "user.email=bot@alchemy.run",
          ...args,
        ],
        cwd,
        timeoutSeconds: 120,
        maxLines: 100,
        maxBytes: 10_000,
        preview: "tail",
      }).pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout.text.trim())
            : Effect.fail(
                `git ${args[0]} failed (exit ${result.exitCode}): ${result.stderr.text || result.stdout.text}`,
              ),
        ),
        Effect.provide(built as never),
      );

    return OrgSandbox.of({
      call: ({ tool, key, params }) =>
        Effect.gen(function* () {
          const callable = registry.get(tool);
          if (callable === undefined) {
            return yield* Effect.fail(
              `the sandbox has no tool named '${tool}'`,
            );
          }
          return yield* callable(params).pipe(
            Effect.mapError((error) => String(error)),
            Effect.provideService(AI.Thread, threadStub(key)),
            Effect.provide(RuntimeContext.phantom),
          ) as Effect.Effect<unknown, string>;
        }),

      push: ({ key, branch, message }) =>
        Effect.gen(function* () {
          const workspace = yield* workspaces
            .checkout({ key, remote })
            .pipe(Effect.mapError((error) => error.message));
          yield* git(workspace.root, ["checkout", "-B", branch]);
          yield* git(workspace.root, ["add", "-A"]);
          const status = yield* git(workspace.root, ["status", "--porcelain"]);
          if (status === "") {
            return yield* Effect.fail(
              "nothing to commit — the workspace has no changes; make the fix before opening a pull request",
            );
          }
          yield* git(workspace.root, ["commit", "-m", message]);
          // force-with-lease: re-running the same key updates its branch
          yield* git(workspace.root, [
            "push",
            "--force-with-lease",
            "-u",
            "origin",
            branch,
          ]);
          return { branch };
        }).pipe(
          Effect.provideService(AI.Thread, threadStub(key)),
          Effect.provide(RuntimeContext.phantom),
        ) as Effect.Effect<{ branch: string }, string>,
    });
  }),
);
