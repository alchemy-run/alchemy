/**
 * The org, deployed — everything on Cloudflare, nothing local:
 *
 * - {@link Worker} (src/Worker.ts) — the backend: sessions as
 *   Durable Objects, board/ledger/approvals on D1, GitHub by
 *   webhook + token bindings, each session's tools on its OWN
 *   container of the circular org image (the alchemy repo baked in —
 *   Sandbox.ts);
 * - `Website` — the coding-agent SPA, built by Vite at deploy and
 *   served as Worker assets, with `/api/*` and `/attach/*` forwarded
 *   to the backend over a service binding (ui/edge.ts).
 *
 * Run with the operator's shell env carrying `ANTHROPIC_API_KEY` (it
 * binds as a Worker secret at deploy):
 *
 * ```sh
 * bun alchemy deploy
 * ```
 */
import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { testAlchemy } from "./src/Repos.ts";
import { SandboxMicrovmRuntime } from "./src/SandboxMicrovm.ts";
import Worker from "./src/Worker.ts";

export default Alchemy.Stack(
  "Org",
  {
    providers: Layer.mergeAll(
      GitHub.providers(),
      Cloudflare.providers(),
      // the MicroVM sandbox option provisions AWS resources (the image,
      // its build role, the Worker's cross-cloud IAM user/role)
      AWS.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const repo = yield* testAlchemy;
    const org = yield* Worker;

    const site = yield* Cloudflare.Website.Vite("Website", {
      // the SPA is its own vite project in ui/ (config included) — the
      // edge module forwards /api and /attach to the backend over the
      // service binding; everything else is assets + SPA fallback
      rootDir: "ui",
      main: "edge.ts",
      env: {
        ORG: Worker,
      },
      // PINNED dev port: without it the Worker and the Website both
      // race for the default (1337), and every restart reshuffles —
      // the app must live at ONE address across restarts
      dev: { port: 1337 },
      assets: {
        notFoundHandling: "single-page-application",
        runWorkerFirst: ["/api/*", "/attach/*", "/terminal/*"],
      },
      memo: {
        include: ["**/*", "../package.json"],
        lockfile: true,
      },
    });

    return {
      repository: repo.fullName,
      /** The app: SPA + forwarded API, one origin. */
      url: site.url,
      /** The backend's own door (the GitHub webhook targets this). */
      api: org.url,
    };
  }).pipe(
    // The session sandbox image — HARDCODED to the AWS Lambda MicroVM
    // (Firecracker; the SAME guest physics as the container image,
    // built server-side on AWS; locally, floci emulates the MicroVM
    // API), with the alchemy repo BAKED IN (src/SandboxMicrovm.ts):
    // each session's VM is a warm worktree of `sam/harness`. To go
    // back to the Cloudflare Container machine, swap for
    // `Cloudflare.AI.SandboxContainerRuntime` (and mirror the swap in
    // src/Worker.ts + src/services/DriverCloudflare.ts).
    Effect.provide(SandboxMicrovmRuntime),
  ),
);
