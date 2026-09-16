import * as AI from "alchemy/AI";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Dockerfile from "alchemy/Docker/Dockerfile";
import * as Workspace from "alchemy/Workspace";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * The org sandbox IMAGE — the circular one: the alchemy repository
 * itself, checked out (`sam/harness`, submodules resolved), installed,
 * and pre-type-checked at IMAGE BUILD, so every session's container
 * wakes up inside a ready dev tree with zero cold setup. The coding
 * agent works ON alchemy FROM alchemy.
 *
 * The checkout is a snapshot from build time — a session that needs
 * the latest code runs `git pull` itself (the tree is a normal clone
 * with its remote intact). The type-check is best-effort (`|| true`):
 * a red build on the branch must not brick the sandbox image.
 */
export const SANDBOX_DOCKERFILE = Dockerfile.inline`
  FROM oven/bun:1

  RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates curl git ripgrep openssh-client unzip \
    && rm -rf /var/lib/apt/lists/*

  WORKDIR /workspace

  RUN git clone --branch sam/harness --recurse-submodules --shallow-submodules \
      https://github.com/alchemy-run/alchemy.git alchemy

  WORKDIR /workspace/alchemy

  RUN bun install
  RUN cd distilled && bun install
  RUN bun tsc -b || true
`;

/**
 * The org's runtime for {@link Cloudflare.AI.SandboxContainerImage} —
 * the SAME contract and guest physics as the stock
 * `Cloudflare.AI.SandboxContainerRuntime` (RPC over
 * `makeSandboxLocal`), on the circular image above, rooted at the
 * baked checkout: every tool path is repo-relative from
 * `/workspace/alchemy`.
 *
 * Provide it on the Stack program (alchemy.run.ts) so the image is
 * built, pushed, and the ContainerApplication deployed.
 */
export const SandboxRuntime = Cloudflare.AI.SandboxContainerImage.make(
  {
    main: import.meta.url,
    runtime: "bun",
    dockerfile: SANDBOX_DOCKERFILE,
  },
  Effect.gen(function* () {
    const sandbox = yield* AI.makeSandboxLocal;
    return {
      exec: sandbox.exec,
      readFile: sandbox.readFile,
      writeFile: sandbox.writeFile,
      deleteFile: sandbox.deleteFile,
      mkdir: sandbox.mkdir,
      listFiles: sandbox.listFiles,
      exists: sandbox.exists,
      // the RPC surface is the product; fetch only answers health checks
      fetch: HttpServerResponse.json({ ok: true }),
    };
  }).pipe(Effect.provide(Workspace.fixed("/workspace/alchemy"))),
);

/** The container entry contract: the module default-exports its runtime. */
export default SandboxRuntime;
