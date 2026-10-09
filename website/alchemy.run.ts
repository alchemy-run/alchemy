import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Output from "alchemy/Output";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
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

    // Docs search: production owns one AI Search instance that crawls the
    // live site. Every other stage proxies `/api/search` to production (see
    // src/search-api.ts) rather than crawling and indexing its own copy.
    const docsSearch =
      stack.stage === "prod"
        ? yield* Cloudflare.AI.Search("DocsSearch", {
            source: "https://alchemy.run",
            parse: {
              type: "sitemap",
              // Unlike sitemap-index.xml, lists the noindex API reference pages.
              specificSitemaps: ["https://alchemy.run/search-sitemap.xml"],
              contentSelector: [{ path: "**", selector: "main" }],
            },
            // Read from each page's <meta> tags (src/components/starlight/Head.astro).
            customMetadata: [
              { fieldName: "title", dataType: "text" },
              { fieldName: "description", dataType: "text" },
              { fieldName: "provider", dataType: "text" },
              { fieldName: "section", dataType: "text" },
            ],
            syncInterval: 21600,
            indexOnCreate: true,
          })
        : undefined;

    return {
      name,
      env: docsSearch ? { DOCS_SEARCH: docsSearch } : undefined,
      command: "bun run build",
      main: "./src/worker.ts",
      outdir: "dist",
      preview: previewParent
        ? {
            of: previewParent,
            name: stack.stage,
            message: process.env.PULL_REQUEST ? `PR #${process.env.PULL_REQUEST}` : undefined,
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
      yield* GitHub.Comment("preview-comment", {
        owner: "alchemy-run",
        repository: "alchemy",
        issueNumber: Number(process.env.PULL_REQUEST),
        body: Output.interpolate`
          ## Website Preview Deployed

          **URL:** ${website.url}

          Built from commit ${
            // `BUILD_SHA` is set by .github/workflows/deploy.yml to the
            // PR head SHA (or `github.sha` for push deploys). The
            // ambient `GITHUB_SHA` would point at the synthetic merge
            // commit on `pull_request` events, which is not what
            // anyone wants to see in the comment.
            process.env.BUILD_SHA
              ? `[\`${process.env.BUILD_SHA.slice(0, 7)}\`](https://github.com/alchemy-run/alchemy/commit/${process.env.BUILD_SHA})`
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
