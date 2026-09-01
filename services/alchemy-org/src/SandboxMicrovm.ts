import * as AI from "alchemy/AI";
import * as AWS from "alchemy/AWS";
import * as Workspace from "alchemy/Workspace";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * The org sandbox MicroVM image — the circular one, the Firecracker
 * sibling of the Container image in `Sandbox.ts`: a FRESH depth-1
 * clone of the alchemy repository (plus its distilled and floci
 * submodules at their pinned commits), installed and compiled at
 * IMAGE BUILD. No host snapshot, no staging — the image is exactly
 * what a new contributor's first checkout is: clone, `pnpm install`,
 * `tsc -b`, and a packaged floci for local AWS emulation.
 *
 * The bake is a snapshot of `main` at build time — sessions converge
 * to the branch tip at claim time anyway (`CheckoutsSandbox` fetches
 * and lands on the branch), so image staleness only costs the delta
 * fetch, never correctness.
 *
 * Layer order is load-bearing: ALL binaries install FIRST (dnf, pnpm,
 * bun, JDK) — those layers are stable across bakes, so a re-bake
 * re-runs only the clone-and-build layers below them, and the floci
 * emulator's layer cache stays warm across Dockerfile-tail changes.
 *
 * bun is installed for the repo's prepare/build scripts but
 * deliberately NOT linked into `/usr/local/bin` — the MicroVM codegen
 * appends its own runtime install step whose `ln -s` must not collide.
 *
 * LOCAL DEV: the floci emulator caps image builds at 15 minutes, which
 * a cold bake exceeds — warm the shared docker layer cache once with
 * `scripts/warm-bake.ts` (see its doc) whenever the bake changes.
 */
export const SANDBOX_DOCKERFILE = `
${AWS.AI.SANDBOX_MICROVM_DOCKERFILE.trim()}

# ── binaries FIRST: stable layers shared by every bake ─────────────
# node 24 + pnpm 11.24 + bun 1.3.13 match the repo's devEngines /
# packageManager pins. unzip is for the bun installer; the JDK builds
# .vendor/floci (maven.compiler.release 25).
RUN dnf install -y unzip nodejs24 nodejs24-npm java-25-amazon-corretto-devel \\
  && dnf clean all \\
  && npm install -g pnpm@11.24.0

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.13"

ENV PATH="/root/.bun/bin:\${PATH}"

# ── the SEED: one cold first-checkout build, frozen as layers ───────
# A depth-1 clone of main plus distilled and floci at their PINNED
# submodule commits (the workspace only compiles against the distilled
# it pins; NOT recursive — distilled's spec-mirror submodules are
# multi-GB codegen inputs sessions never need; floci's .gitmodules
# says update=none, overridden here). Then the full build: install
# (the prepare chain patches tsc, builds the cloudflare packages,
# generates the eval runtime), tsc -b, and the floci jar.
#
# These layers are the CACHE the tip layer below builds on: the pnpm
# store, every tsbuildinfo, and ~/.m2 stay warm inside them, so they
# re-run only when this Dockerfile changes.
RUN git clone --depth 1 https://github.com/alchemy-run/alchemy.git /workspace/alchemy \\
  && cd /workspace/alchemy \\
  && git submodule update --init --depth 1 distilled \\
  && git -c submodule."vendor/floci".update=checkout \\
       submodule update --init --depth 1 .vendor/floci \\
  && git config user.email "org@alchemy.run" \\
  && git config user.name "alchemy-org"

WORKDIR /workspace/alchemy

RUN pnpm install --frozen-lockfile
RUN cd distilled && pnpm install --frozen-lockfile
RUN pnpm exec tsc -b
RUN cd .vendor/floci && ./mvnw --quiet --batch-mode -DskipTests package

# ── the TIP: converge to the branch head, INCREMENTALLY ─────────────
# Same steps as the seed, but over its warm caches — a few minutes,
# the local-rebuild experience. REFRESH busts only this layer (the
# warm-bake script passes a timestamp); the snapshot may lag main
# between refreshes, which is harmless: sessions fetch and land on
# the branch tip at claim time anyway.
ARG REFRESH=0
RUN echo "refresh \${REFRESH}" \\
  && git fetch --depth 1 origin main \\
  && git reset --hard origin/main \\
  && git submodule update --depth 1 distilled \\
  && git -c submodule."vendor/floci".update=checkout \\
       submodule update --depth 1 .vendor/floci \\
  && pnpm install --frozen-lockfile \\
  && (cd distilled && pnpm install --frozen-lockfile) \\
  && pnpm exec tsc -b \\
  && (cd .vendor/floci && ./mvnw --quiet --batch-mode -DskipTests package)
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
    // No build context beyond the bundled entry: the workspace is a
    // fresh network clone at image-build time (see the Dockerfile),
    // so the image rebuilds only when the Dockerfile itself changes.
    return {
      main: import.meta.url,
      runtime: "bun" as const,
      dockerfile: SANDBOX_DOCKERFILE,
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
