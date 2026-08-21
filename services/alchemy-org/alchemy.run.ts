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
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { testAlchemy } from "./src/Repos.ts";
import Worker from "./src/Worker.ts";

export default Alchemy.Stack(
  "Org",
  {
    providers: Layer.mergeAll(GitHub.providers(), Cloudflare.providers()),
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
        // the backend's own origin, inlined into the client bundle
        // (`import.meta.env.VITE_API_ORIGIN`): the SPA attaches its
        // session SOCKETS directly to the Worker — same-origin HTTP
        // rides the service binding, but WebSocket upgrades do not
        // survive the dev chain's node upstream (runtime bug, tracked)
        VITE_API_ORIGIN: org.url.as<string>(),
      },
      // PINNED dev port: without it the Worker and the Website both
      // race for the default (1337), and every restart reshuffles —
      // the app must live at ONE address across restarts
      dev: { port: 1337 },
      assets: {
        notFoundHandling: "single-page-application",
        runWorkerFirst: ["/api/*", "/attach/*"],
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
    // The session sandbox image. The STOCK slim image for now (bun +
    // git + ripgrep; builds in seconds): the review pipeline clones its
    // PR into /workspace per session, so nothing needs a pre-baked
    // tree. The CIRCULAR image (src/Sandbox.ts — the whole alchemy
    // repo checked out, installed, and compiled) swaps in here once
    // the runtime builds images off the worker's startup path: baking
    // it takes many minutes, and today that blocks every request.
    Effect.provide(Cloudflare.AI.SandboxContainerRuntime),
  ),
);
