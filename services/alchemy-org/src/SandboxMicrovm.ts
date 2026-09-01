import * as AI from "alchemy/AI";
import * as AWS from "alchemy/AWS";
import * as Workspace from "alchemy/Workspace";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { stageBake } from "./SandboxBake.ts";

/**
 * The org sandbox MicroVM image — the circular one, the Firecracker
 * sibling of the Container image in `Sandbox.ts`: the host's OWN
 * working tree, copied in wholesale (`SandboxBake.ts` stages it with
 * a locally-crafted depth-1 `.git` — no network clone, no worktree/
 * submodule-gitdir tonnage), with ZERO in-image builds beyond the one
 * thing that cannot ship: linux `node_modules`.
 *
 * Everything compiled comes from the host — `lib/`, `dist/`,
 * tsbuildinfo, and the floci jar (`.vendor/floci/target`, built
 * locally with `./mvnw -DskipTests package`). The bake is a snapshot
 * of the host workspace at deploy time, dirty state included; a
 * session that needs newer code fetches it (session claims land on
 * the branch tip anyway — `CheckoutsSandbox`).
 *
 * TWO-STAGE for size: the `workspace` stage pays the pnpm store
 * (~2.5GB that hardlinks cannot dedupe across docker layers) and is
 * discarded — the final image is toolchain + one COPY of the built
 * workspace. Layer order is load-bearing for re-bake cost: binaries
 * first (stable), lockfile-only `pnpm fetch` next (the store layer
 * survives tree edits), the full tree COPY last.
 *
 * No JDK ships: a session that wants to RUN the floci jar restores
 * java per-session (`dnf install -y java-25-amazon-corretto-headless`,
 * ~30s in the VM).
 *
 * bun is installed for sessions' scripts but deliberately NOT linked
 * into `/usr/local/bin` — the MicroVM codegen appends its own runtime
 * install step whose `ln -s` must not collide.
 *
 * LOCAL DEV: the floci emulator caps image builds at 15 minutes — the
 * binary + store layers exceed that COLD, so warm the shared docker
 * layer cache once with `scripts/warm-bake.ts` after Dockerfile
 * changes.
 */
export const SANDBOX_DOCKERFILE = `
${AWS.AI.SANDBOX_MICROVM_DOCKERFILE.trim().replace(/^FROM (.*)$/m, "FROM $1 AS base")}

# ── toolchain: stable layers shared by every bake AND both stages ──
# node 24 + pnpm 11.24 + bun 1.3.13 match the repo's devEngines /
# packageManager pins; unzip is for the bun installer. Weak deps
# (docs, i18n, fonts) stay out. NO JDK: floci's host-built jar ships
# in the tree, and a session that wants to RUN it restores java
# per-session with \`dnf install -y java-25-amazon-corretto-headless\`.
RUN dnf install -y --setopt=install_weak_deps=False unzip findutils nodejs24 nodejs24-npm \\
  && dnf clean all \\
  && npm install -g pnpm@11.24.0

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.13"

ENV PATH="/root/.bun/bin:\${PATH}"

# ── WORKSPACE stage: the pnpm store lives and dies HERE ─────────────
# The store is ~2.5GB the final image must not carry: hardlinks do
# not survive docker layer boundaries (overlayfs copies up), so a
# same-image store + node_modules doubles the bill. This stage pays
# it, the final stage copies only /workspace/alchemy out of it.
FROM base AS workspace

# dependency store: lockfiles only, so the layer survives tree edits
COPY alchemy/package.json alchemy/pnpm-workspace.yaml alchemy/pnpm-lock.yaml /workspace/alchemy/
COPY alchemy/patches/ /workspace/alchemy/patches/
COPY alchemy/distilled/package.json alchemy/distilled/pnpm-workspace.yaml alchemy/distilled/pnpm-lock.yaml /workspace/alchemy/distilled/

WORKDIR /workspace/alchemy

RUN pnpm fetch
RUN cd distilled && pnpm fetch

# the host's tree, as-is
COPY alchemy/ /workspace/alchemy/

# Restore exec bits from the index (zip transport drops them; a plain
# \`git checkout -- .\` would clobber the host's uncommitted edits, so
# only MODES are restored), commit identity for sessions, and the
# floci launcher sessions may invoke.
RUN git ls-files -s | grep ^100755 | cut -f2 | xargs -r -d '\\n' chmod +x \\
  && chmod +x .vendor/floci/mvnw \\
  && git config user.email "org@alchemy.run" \\
  && git config user.name "alchemy-org"

# the ONLY install: linux node_modules from the warm store.
# --ignore-scripts skips the prepare chain (its outputs shipped from
# the host); effect-tsgo's tsc patch targets the FRESH node_modules,
# so it re-runs — it is a patch, not a build.
RUN pnpm install --frozen-lockfile --prefer-offline --ignore-scripts \\
  && cd distilled && pnpm install --frozen-lockfile --prefer-offline --ignore-scripts
RUN pnpm exec effect-tsgo patch

# ── FINAL: toolchain + the built workspace, store left behind ───────
FROM base

COPY --from=workspace /workspace/alchemy /workspace/alchemy

WORKDIR /workspace/alchemy
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
    // Stage the LOCAL working tree (wholesale copy + local depth-1
    // .git) into the build context; the fingerprint (HEAD + dirty-file
    // stats + build-artifact stats) drives the diff, so the image
    // rebuilds when the workspace actually changed.
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
      // type-checks inside the VM (tsc -b over this workspace alone
      // wants ~8GB of heap)
      resources: [{ minimumMemoryInMiB: 8192 }],
      // a new bake means every running machine serves a STALE tree —
      // recycle them; sessions relaunch their machine on next use
      recycleMicrovmsOnUpdate: true,
    };
  }),
  Effect.gen(function* () {
    const sandbox = yield* AI.makeSandboxLocal;
    // the interactive shell surface (`Bun.Terminal`) — terminals open
    // in the baked checkout, exactly where the tools work
    const pty = yield* AI.makeSandboxPty;
    return {
      ...sandbox,
      ...pty,
      // the RPC surface is the product; fetch only answers health checks
      fetch: HttpServerResponse.json({ ok: true }),
    };
  }).pipe(Effect.provide(Workspace.fixed("/workspace/alchemy"))),
);

/** The image entry contract: the module default-exports its runtime. */
export default SandboxMicrovmRuntime;
