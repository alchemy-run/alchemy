import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type WorkerEnv = Cloudflare.InferEnv<typeof Website>;

const Website = Cloudflare.StaticSite(
  "Website",
  Alchemy.Stack.useSync((stack) => ({
    command: "bun astro build",
    main: "./src/worker.ts",
    outdir: "dist",
    domain: stack.stage === "prod" ? "v2.alchemy.run" : undefined,
    memo: {
      include: [
        "src/**",
        "astro.config.mjs",
        "package.json",
        "public/**",
        "../bun.lock",
      ],
    },
    compatibility: {
      date: "2026-04-02",
      flags: ["nodejs_compat"],
    },
    assetsConfig: {
      runWorkerFirst: true,
    },
  })),
);

export default Alchemy.Stack(
  "AlchemyEffectWebsite",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const website = yield* Website;

    if (process.env.PULL_REQUEST) {
      yield* GitHub.Comment("preview-comment", {
        owner: "alchemy-run",
        repository: "alchemy-effect",
        issueNumber: Number(process.env.PULL_REQUEST),
        body: Output.interpolate`
          ## Website Preview Deployed

          **URL:** ${website.url}

          Built from commit ${process.env.GITHUB_SHA?.slice(0, 7) ?? "unknown"}.

          ---
          _This comment updates automatically with each push._
        `,
      });
    }

    return {
      url: website.url,
    };
  }),
);
