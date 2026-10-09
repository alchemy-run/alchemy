import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Output from "alchemy/Output";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { DocsText, DocsVectors, IndexDocs } from "./search/index.ts";

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

    // Docs search: production owns the index (see search/index.ts) and the
    // query log; every other stage proxies `/api/search` to production.
    let env;
    if (stack.stage === "prod") {
      // Every docs search query is logged to Axiom (see src/search-api.ts).
      const datasetName = `alchemy-docs-search-${stack.stage}`;
      const queries = yield* Axiom.Dataset("DocsSearchQueries", {
        name: datasetName,
        description: "Queries typed into the docs search on alchemy.run",
      });
      const ingest = yield* Axiom.ApiToken("DocsSearchIngest", {
        name: `alchemy-docs-search-ingest-${stack.stage}`,
        datasetCapabilities: { [datasetName]: { ingest: ["create"] } },
      });
      env = {
        AI: Cloudflare.Workers.AI(),
        DOCS_VECTORS: yield* DocsVectors,
        DOCS_TEXT: yield* DocsText,
        SEARCH_LOG_URL: Output.interpolate`${queries.edgeDeploymentUrl}/v1/ingest/${queries.name}`,
        SEARCH_LOG_TOKEN: ingest.token,
      };
    }

    return {
      name,
      env,
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
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers(), Axiom.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const website = yield* Website;

    if (stage === "prod") {
      // Re-index whenever the built site changes.
      yield* IndexDocs({ assets: Output.map(website.hash, (hash) => hash?.assets) });
    }

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
