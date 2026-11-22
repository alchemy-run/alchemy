import * as Cloudflare from "@alchemy.run/cloudflare";
import * as GitHub from "@alchemy.run/github";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type WorkerEnv = Cloudflare.InferEnv<typeof Website>;

const Website = Cloudflare.Website.StaticSite(
  "Website",
  Effect.gen(function* () {
    const stack = yield* Alchemy.Stack;
    const previewParent = stack.stage.startsWith("pr-")
      ? yield* Cloudflare.Worker.ref("Website", { stage: "preview-base" })
      : undefined;
    const name =
      stack.stage === "preview-base"
        ? "alchemy-website-preview"
        : stack.stage === "main"
          ? "alchemy-website-main"
          : stack.stage === "prod"
            ? "alchemy-website-prod"
            : undefined;
    const pullRequest = yield* Config.String("PULL_REQUEST").pipe(Config.withDefault(undefined));

    return {
      name,
      command: "bun run build",
      main: "./src/worker.ts",
      outdir: "dist",
      preview: previewParent
        ? {
            of: previewParent,
            name: stack.stage,
            message: pullRequest ? `PR #${pullRequest}` : undefined,
          }
        : undefined,
      workersDev: stack.stage === "prod" ? false : undefined,
      domain:
        stack.stage === "prod"
          ? {
              name: "alchemy.run",
              redirects: ["v2.alchemy.run"],
              previews: true,
            }
          : stack.stage === "main"
            ? { name: "main.alchemy.run" }
            : undefined,
      memo: {
        include: [
          "src/**",
          "astro.config.mjs",
          "package.json",
          "plugins/**",
          "public/**",
          "scripts/**",
          "../bun.lock",
        ],
      },
      compatibility: {
        date: "2026-04-02",
        flags: ["nodejs_compat"],
      },
      assets: {
        runWorkerFirst: true,
      },
    } satisfies Cloudflare.Website.StaticSiteProps<{}>;
  }),
).pipe(
  RemovalPolicy.retain(Alchemy.Stack.pipe(Effect.map(({ stage }) => !stage.startsWith("pr-")))),
);

export default Alchemy.Stack(
  "AlchemyEffectWebsite",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const website = yield* Website;

    if (stage.startsWith("pr-")) {
      const pullRequest = yield* Config.String("PULL_REQUEST").pipe(Config.withDefault(undefined));
      const buildSha = yield* Config.String("BUILD_SHA").pipe(Config.withDefault(undefined));
      yield* GitHub.Comment("preview-comment", {
        owner: "alchemy-run",
        repository: "alchemy",
        issueNumber: Number(pullRequest),
        body: Output.interpolate`
          ## Website Preview Deployed

          **URL:** ${website.url}

          Built from commit ${
            // `BUILD_SHA` is set by .github/workflows/deploy.yml to the
            // PR head SHA (or `github.sha` for push deploys). The
            // ambient `GITHUB_SHA` would point at the synthetic merge
            // commit on `pull_request` events, which is not what
            // anyone wants to see in the comment.
            buildSha
              ? `[\`${buildSha.slice(0, 7)}\`](https://github.com/alchemy-run/alchemy/commit/${buildSha})`
              : "unknown"
          }.

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
