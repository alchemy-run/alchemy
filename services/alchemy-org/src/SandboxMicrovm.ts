import * as AI from "alchemy/AI";
import * as AWS from "alchemy/AWS";
import * as Workspace from "alchemy/Workspace";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { stageBake } from "./SandboxBake.ts";

/**
 * The org sandbox MicroVM image — the circular one, the Firecracker
 * sibling of the Container image in `Sandbox.ts`: the alchemy
 * repository itself, COPIED from the local repo root (`SandboxBake.ts`
 * stages the committed tree + a depth-1 `.git` — no network clone) and
 * installed at IMAGE BUILD. Every session's VM wakes up inside a ready
 * dev tree with zero cold setup — the image IS the branch, a warm
 * worktree the session can branch, commit, and publish from
 * (`pushBranch` / `openPullRequest` ride the tree's origin, re-pointed
 * at the real repository by the stager).
 *
 * The bake is a snapshot of local `HEAD` at build time — a session
 * that needs newer code runs `git fetch`/`pull` itself. No type-check
 * in the bake: `tsc -b` over this workspace needs ~8.5GB of heap and
 * gets OOM-killed inside the docker build VM — sessions run it
 * incrementally themselves.
 *
 * Layer order is load-bearing for the per-commit rebuild cost:
 * lockfiles + patches are COPY'd alone and `pnpm fetch`ed BEFORE the
 * full tree, so a new commit re-links from the cached store (seconds)
 * instead of re-downloading the world.
 *
 * Layered on the stock sandbox base (git + ripgrep + ssh); bun is
 * installed for the bake but deliberately NOT linked into
 * `/usr/local/bin` — the MicroVM codegen appends its own runtime
 * install step whose `ln -s` must not collide.
 *
 * LOCAL DEV: the floci emulator caps image builds at 15 minutes, which
 * a cold bake exceeds — warm the shared docker layer cache once with
 * `scripts/warm-bake.ts` (see its doc) whenever the bake changes.
 */
export const SANDBOX_DOCKERFILE = `
${AWS.AI.SANDBOX_MICROVM_DOCKERFILE.trim()}

# node + pnpm: the repo declares packageManager pnpm@11 — its prepare
# script (turbo) resolves that exact binary, and pnpm itself runs on
# node. unzip is for the bun installer below.
RUN dnf install -y unzip nodejs22 && dnf clean all \\
  && npm install -g pnpm@11.21.0

RUN curl -fsSL https://bun.sh/install | bash

# bun on PATH for the repo's prepare/build scripts — NOT linked into
# /usr/local/bin (the MicroVM codegen appends its own runtime install
# whose \`ln -s\` must not collide)
ENV PATH="/root/.bun/bin:\${PATH}"

# Dependency store layer: lockfiles + patches only, so it survives
# commits — pnpm fetch needs nothing but the lockfile. A new bake then
# re-links from the warm store instead of re-downloading everything.
COPY alchemy/package.json alchemy/pnpm-workspace.yaml alchemy/pnpm-lock.yaml /workspace/alchemy/
COPY alchemy/patches/ /workspace/alchemy/patches/
COPY alchemy/distilled/package.json alchemy/distilled/pnpm-workspace.yaml alchemy/distilled/pnpm-lock.yaml /workspace/alchemy/distilled/

WORKDIR /workspace/alchemy

RUN pnpm fetch
RUN cd distilled && pnpm fetch

COPY alchemy/ /workspace/alchemy/

# the copy roundtrip drops exec bits — restore modes from the index,
# and give the tree a commit identity so sessions can commit
RUN git checkout -- . \\
  && git config user.email "org@alchemy.run" \\
  && git config user.name "alchemy-org"

RUN pnpm install --frozen-lockfile --prefer-offline
RUN cd distilled && pnpm install --frozen-lockfile --prefer-offline
`;

/**
 * The org's runtime for {@link AWS.AI.SandboxMicrovmImage} — the SAME
 * contract and guest physics as the stock
 * `AWS.AI.SandboxMicrovmRuntime` (typed RPC over `makeSandboxLocal`),
 * on the circular image above, rooted at the baked checkout: every
 * tool path is repo-relative from `/workspace/alchemy`.
 *
 * Provide it on the Stack program (alchemy.run.ts) so the image is
 * built (server-side on AWS; locally, floci emulates the build) and
 * deployed.
 */
export const SandboxMicrovmRuntime = AWS.AI.SandboxMicrovmImage.make(
  Effect.gen(function* () {
    const buildRole = yield* AWS.AI.SandboxMicrovmBuildRole;
    // Stage the LOCAL repo (committed tree + depth-1 .git) into the
    // build context; the fingerprint (HEAD commits) drives the diff,
    // so the image rebuilds per COMMIT, never per file save.
    //
    // DEPLOY-SIDE ONLY: the platform re-evaluates this props effect
    // inside the deployed guest (where resource constructors resolve
    // from bound context) — running the stager there crashes the VM
    // at boot (its module-relative repo root doesn't exist in the
    // image), so guard it exactly like bindings guard `host.bind`.
    const contextInclude = globalThis.__ALCHEMY_RUNTIME__
      ? []
      : [
          yield* stageBake.pipe(
            Effect.map((bake) => ({
              from: bake.dir,
              to: "alchemy",
              fingerprint: bake.fingerprint,
            })),
          ),
        ];
    return {
      main: import.meta.url,
      runtime: "bun" as const,
      dockerfile: SANDBOX_DOCKERFILE,
      contextInclude,
      buildRole,
      cpuConfigurations: [{ architecture: "ARM_64" as const }],
      // a dev tree, not a stub: sessions run installs, tests, and
      // type-checks inside the VM
      resources: [{ minimumMemoryInMiB: 4096 }],
      // a new bake means every running machine serves a STALE tree —
      // recycle them; sessions relaunch their machine on next use
      recycleMicrovmsOnUpdate: true,
    };
  }),
  Effect.gen(function* () {
    const sandbox = yield* AI.makeSandboxLocal;
    return {
      ...sandbox,
      // the RPC surface is the product; fetch only answers health checks
      fetch: HttpServerResponse.json({ ok: true }),
    };
  }).pipe(Effect.provide(Workspace.fixed("/workspace/alchemy"))),
);

/** The image entry contract: the module default-exports its runtime. */
export default SandboxMicrovmRuntime;
