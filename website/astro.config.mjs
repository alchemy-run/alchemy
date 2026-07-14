// @ts-check
import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import astroBrokenLinksChecker from "astro-broken-links-checker";
import { defineConfig } from "astro/config";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import starlightBlog from "starlight-blog";
import { pagefindIgnoreNoise } from "./plugins/pagefind-ignore-noise.mjs";

/**
 * The Providers sidebar (Provider → Category → Service → Resource) is generated
 * by `scripts/generate-api-reference.ts` from `@category` JSDoc annotations and
 * written to `src/generated/providers-sidebar.json`. `bun run build:reference`
 * regenerates it before every build. If it hasn't been generated yet (e.g. a
 * fresh `astro dev` before running the generator), fall back to autogenerating
 * from the directory tree so the docs still build.
 */
function providersSidebar() {
  try {
    const json = readFileSync(
      fileURLToPath(
        new URL("./src/generated/providers-sidebar.json", import.meta.url),
      ),
      "utf8",
    );
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/**
 * Every provider has a docs hub: its reference tree renders inside the
 * hub's "Resources" group and its reference URLs belong to the hub tab
 * (see docs-tabs.ts). The Reference tab is a directory — its sidebar is
 * just the list of providers, each linking to its hub.
 */
function providersSidebarEntry() {
  return {
    label: "Reference",
    collapsed: false,
    items: [
      { label: "AWS", link: "/aws" },
      { label: "Cloudflare", link: "/cloudflare" },
      { label: "PlanetScale", link: "/planetscale" },
      { label: "Neon", link: "/neon" },
      { label: "Axiom", link: "/axiom" },
      { label: "GitHub", link: "/github" },
      { label: "Docker", link: "/docker" },
      { label: "Kubernetes", link: "/kubernetes" },
      { label: "Drizzle", link: "/drizzle" },
      { label: "Command", link: "/command" },
    ],
  };
}

/**
 * A cloud hub's "Resources" section: that provider's slice of the generated
 * reference tree below Guides, expanded one level (categories/services show,
 * everything inside them stays collapsed) so each hub is self-sufficient.
 *
 * @param {string} provider Provider label / directory name (e.g. "Cloudflare")
 */
function providerResourcesEntry(provider) {
  const group = providersSidebar()?.find((p) => p.label === provider);
  if (group)
    return { label: "Resources", collapsed: false, items: group.items };
  return {
    label: "Resources",
    collapsed: false,
    autogenerate: { directory: `providers/${provider}`, collapsed: true },
  };
}

/**
 * Copies `src/content/docs/**\/*.{md,mdx}` into the build output dir, preserving
 * the directory layout but normalizing extensions to `.md`. This lets the worker
 * serve raw markdown for clients (e.g. coding agents) that prefer it.
 *
 * @returns {import("astro").AstroIntegration}
 */
function copyMarkdownSources() {
  return {
    name: "copy-markdown-sources",
    hooks: {
      "astro:build:done": async ({ dir }) => {
        const outDir = fileURLToPath(dir);

        /**
         * @param {string} srcDir
         * @param {{ lowercase?: boolean }} [opts]
         * @param {string} [relTo]
         */
        async function walk(srcDir, opts = {}, relTo = srcDir) {
          let entries;
          try {
            entries = await fs.readdir(srcDir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            const full = path.join(srcDir, entry.name);
            if (entry.isDirectory()) {
              await walk(full, opts, relTo);
              continue;
            }
            if (!entry.isFile()) continue;
            const ext = path.extname(entry.name).toLowerCase();
            if (ext !== ".md" && ext !== ".mdx") continue;
            let rel = path.relative(relTo, full);
            rel = rel.slice(0, rel.length - ext.length) + ".md";
            // Starlight lowercases doc URLs (e.g. CamelCase source
            // `providers/AWS/S3/Bucket.md` is served at `/providers/aws/s3/bucket`),
            // so the raw-markdown copy must live at the lowercased path or the
            // worker's `/providers/aws/s3/bucket.md` lookup 404s into HTML.
            if (opts.lowercase) rel = rel.toLowerCase();
            const target = path.join(outDir, rel);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.copyFile(full, target);
          }
        }

        // Docs (Starlight content collection) — preserves nested layout under
        // /content/docs/ → /<path>.md, lowercased to match Starlight's URLs.
        await walk(
          fileURLToPath(new URL("./src/content/docs/", import.meta.url)),
          { lowercase: true },
        );
        // Marketing pages (top-level Astro pages) — exposes /<page>.md so
        // agents can fetch raw MDX via the worker's content negotiation. Astro
        // page routing preserves case, so don't lowercase these.
        await walk(fileURLToPath(new URL("./src/pages/", import.meta.url)));
      },
    },
  };
}

/**
 * Case-sensitive internal-link checker. astro-broken-links-checker uses
 * `fs.existsSync`, which is case-insensitive on macOS — so `/foo/Bar` will
 * resolve to `/foo/bar` locally but 404 on Linux CI. This integration walks
 * the build output once into a case-sensitive Set of paths and validates
 * every `href`/`src` against it.
 *
 * @returns {import("astro").AstroIntegration}
 */
function caseSensitiveLinkChecker() {
  return {
    name: "case-sensitive-link-checker",
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        const distPath = fileURLToPath(dir);

        /** @type {Set<string>} */
        const paths = new Set();
        /** @type {Set<string>} */
        const dirs = new Set();
        /**
         * @param {string} d
         */
        async function walk(d) {
          const entries = await fs.readdir(d, { withFileTypes: true });
          for (const entry of entries) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) {
              dirs.add("/" + path.relative(distPath, full));
              await walk(full);
            } else if (entry.isFile()) {
              paths.add("/" + path.relative(distPath, full));
            }
          }
        }
        await walk(distPath);

        /** @type {Map<string, Set<string>>} */
        const broken = new Map();
        const htmlFiles = [...paths].filter((p) => p.endsWith(".html"));

        for (const htmlFile of htmlFiles) {
          const html = await fs.readFile(
            path.join(distPath, htmlFile.slice(1)),
            "utf8",
          );
          const links = [
            ...html.matchAll(/<a\s+[^>]*href="([^"#?]+)/gi),
            ...html.matchAll(/<img\s+[^>]*src="([^"#?]+)/gi),
          ].map((m) => m[1]);

          for (const link of links) {
            if (!link.startsWith("/")) continue; // skip external, anchors, mailto, etc.
            const clean = link.replace(/\/$/, "");
            const fileCandidates = [
              clean,
              clean + "/index.html",
              clean + ".html",
            ];
            const exists =
              fileCandidates.some((c) => paths.has(c)) || dirs.has(clean);
            if (!exists) {
              if (!broken.has(link)) broken.set(link, new Set());
              broken.get(link)?.add(htmlFile);
            }
          }
        }

        if (broken.size > 0) {
          let msg = "Case-sensitive broken links detected:\n";
          for (const [link, docs] of broken.entries()) {
            msg += `\n  ${link}\n    Found in:\n`;
            for (const doc of docs) msg += `      - ${doc}\n`;
          }
          logger.error(msg);
          throw new Error(
            `Case-sensitive broken links detected (${broken.size})`,
          );
        }
        logger.info(
          `Case-sensitive link check passed (${htmlFiles.length} pages)`,
        );
      },
    },
  };
}

export default defineConfig({
  site: "https://v2.alchemy.run",
  prefetch: true,
  trailingSlash: "ignore",
  integrations: [
    react(),
    pagefindIgnoreNoise(),
    copyMarkdownSources(),
    astroBrokenLinksChecker({
      checkExternalLinks: false,
      throwError: true,
    }),
    caseSensitiveLinkChecker(),
    sitemap({
      filter: (page) =>
        !page.endsWith(".html") &&
        !page.endsWith(".md") &&
        !page.endsWith(".mdx"),
    }),
    starlight({
      title: "alchemy",
      favicon: "/favicon.svg",
      customCss: ["./src/styles/global.css", "./src/styles/custom.css"],
      components: {
        ThemeProvider: "./src/components/ThemeProvider.astro",
        Header: "./src/components/starlight/Header.astro",
        Head: "./src/components/starlight/Head.astro",
        Sidebar: "./src/components/starlight/Sidebar.astro",
      },
      prerender: true,
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/alchemy-run/alchemy-effect",
        },
        {
          icon: "discord",
          label: "Discord",
          href: "https://discord.gg/jwKw8dBJdN",
        },
      ],
      editLink: {
        baseUrl:
          "https://github.com/alchemy-run/alchemy-effect/edit/main/website",
      },
      // One top-level group per docs tab (see src/docs-tabs.ts). The
      // docs-tabs-sidebar middleware swaps in the active tab's group, so
      // the rendered sidebar only ever navigates within the current tab.
      sidebar: [
        {
          label: "Core",
          items: [
            { label: "What is Alchemy?", link: "/what-is-alchemy" },
            { label: "Getting started", link: "/getting-started" },
            { label: "Migrating from v1", link: "/migrating-from-v1" },
            {
              label: "Infrastructure as Code",
              items: [
                { label: "Stacks", link: "/infrastructure-as-code/stack" },
                {
                  label: "Resources",
                  link: "/infrastructure-as-code/resource",
                },
                { label: "Actions", link: "/infrastructure-as-code/action" },
                {
                  label: "Inputs & Outputs",
                  link: "/infrastructure-as-code/outputs",
                },
                {
                  label: "References",
                  link: "/infrastructure-as-code/references",
                },
                {
                  label: "Resource lifecycle",
                  link: "/infrastructure-as-code/resource-lifecycle",
                },
                {
                  label: "Providers",
                  link: "/infrastructure-as-code/provider",
                },
                {
                  label: "Custom Provider",
                  link: "/infrastructure-as-code/custom-provider",
                },
              ],
            },
            {
              label: "Infrastructure as Effects",
              items: [
                {
                  label: "Overview",
                  link: "/infrastructure-as-effects",
                },
                {
                  label: "Functions & Servers",
                  link: "/infrastructure-as-effects/functions-and-servers",
                },
                {
                  label: "Bindings",
                  link: "/infrastructure-as-effects/binding",
                },
                {
                  label: "Event Sources",
                  link: "/infrastructure-as-effects/event-sources",
                },
                {
                  label: "Sinks",
                  link: "/infrastructure-as-effects/sinks",
                },
                { label: "Phases", link: "/infrastructure-as-effects/phases" },
                { label: "Layers", link: "/infrastructure-as-effects/layers" },
                {
                  label: "Building with Layers",
                  link: "/infrastructure-as-effects/infrastructure-layers",
                },
                {
                  label: "Circular Bindings",
                  link: "/infrastructure-as-effects/circular-bindings",
                },
                {
                  label: "Custom Runtime",
                  link: "/infrastructure-as-effects/custom-runtime",
                },
              ],
            },
            {
              label: "APIs",
              items: [
                {
                  label: "Overview",
                  link: "/apis",
                },
                {
                  label: "Schemaless RPC",
                  link: "/apis/schemaless",
                },
                {
                  label: "Effect RPC",
                  link: "/apis/effect-rpc",
                },
                {
                  label: "Effect HTTP",
                  link: "/apis/effect-http",
                },
              ],
            },
            {
              label: "Environments",
              items: [
                { label: "Stages", link: "/environments/stages" },
                { label: "Profiles", link: "/environments/profiles" },
                {
                  label: "Auth Providers",
                  link: "/environments/auth-providers",
                },
                {
                  label: "Custom Auth Provider",
                  link: "/environments/custom-auth-provider",
                },
                { label: "Secrets & Config", link: "/environments/secrets" },
                {
                  label: "Local development",
                  link: "/environments/local-development",
                },
                { label: "CI", link: "/environments/ci" },
              ],
            },
            {
              label: "State Store",
              items: [
                { label: "State Store", link: "/state-store" },
                {
                  label: "Custom State Store",
                  link: "/state-store/custom-state-store",
                },
              ],
            },
            {
              label: "Project structure",
              items: [
                {
                  label: "File layout",
                  link: "/project-structure/file-layout",
                },
                { label: "Monorepo", link: "/project-structure/monorepo" },
                {
                  label: "Single Stack",
                  link: "/project-structure/monorepo-single-stack",
                },
                {
                  label: "Multiple Stacks",
                  link: "/project-structure/monorepo-multi-stack",
                },
              ],
            },
            {
              label: "Testing & observability",
              items: [
                { label: "Testing", link: "/testing" },
                {
                  label: "Testing a Stack",
                  link: "/testing/testing-a-stack",
                },
                {
                  label: "Testing Providers",
                  link: "/testing/testing-providers",
                },
                { label: "Test harness", link: "/testing/test-harness" },
                { label: "Observability", link: "/testing/observability" },
              ],
            },
          ],
        },
        {
          label: "CLI",
          items: [
            { label: "Overview", link: "/cli" },
            {
              label: "Deploy",
              items: [
                { label: "deploy", link: "/cli/deploy" },
                { label: "plan", link: "/cli/plan" },
                { label: "destroy", link: "/cli/destroy" },
                { label: "nuke", link: "/cli/nuke" },
                {
                  label: "Adopting Resources",
                  link: "/cli/adopting-resources",
                },
              ],
            },
            {
              label: "Develop",
              items: [
                { label: "dev", link: "/cli/dev" },
                { label: "tail", link: "/cli/tail" },
                { label: "logs", link: "/cli/logs" },
              ],
            },
            {
              label: "Auth",
              items: [
                { label: "login", link: "/cli/login" },
                { label: "profile", link: "/cli/profile" },
              ],
            },
            {
              label: "State",
              items: [
                { label: "state", link: "/cli/state" },
                {
                  label: "Inspecting State",
                  link: "/cli/inspecting-state",
                },
              ],
            },
            {
              label: "Providers",
              items: [
                { label: "aws", link: "/cli/aws" },
                { label: "cloudflare", link: "/cli/cloudflare" },
              ],
            },
          ],
        },
        {
          label: "Cloudflare",
          items: [
            { label: "Overview", link: "/cloudflare" },
            { label: "Setup", link: "/cloudflare/setup" },
            {
              label: "Tutorial",
              autogenerate: { directory: "cloudflare/tutorial" },
            },
            {
              label: "Compute",
              items: [
                { label: "Workers", link: "/cloudflare/compute/workers" },
                {
                  label: "Durable Objects",
                  link: "/cloudflare/compute/durable-objects",
                },
                { label: "Containers", link: "/cloudflare/compute/containers" },
                { label: "Workflows", link: "/cloudflare/compute/workflows" },
                {
                  label: "Cross-worker DOs",
                  link: "/cloudflare/compute/cross-worker-durable-object",
                },
                {
                  label: "WebSockets",
                  link: "/cloudflare/compute/hibernatable-websockets",
                },
                {
                  label: "Rate limiting",
                  link: "/cloudflare/compute/rate-limiting",
                },
                { label: "Workers Cache", link: "/cloudflare/compute/cache" },
                {
                  label: "Worker Loader",
                  link: "/cloudflare/compute/worker-loader",
                },
                {
                  label: "Workers for Platforms",
                  link: "/cloudflare/compute/workers-for-platforms",
                },
                {
                  label: "Browser rendering",
                  link: "/cloudflare/compute/browser-rendering",
                },
              ],
            },
            {
              label: "Frontend",
              items: [
                {
                  label: "Overview",
                  link: "/cloudflare/frontend/frontends",
                },
                { label: "Vite", link: "/cloudflare/frontend/vite" },
                {
                  label: "Static sites",
                  link: "/cloudflare/frontend/static-site",
                },
                { label: "React SPA", link: "/cloudflare/frontend/vite-spa" },
                {
                  label: "TanStack Start",
                  link: "/cloudflare/frontend/tanstack-start",
                },
                {
                  label: "Full-stack RPC + Drizzle",
                  link: "/cloudflare/frontend/full-stack-tanstack-rpc-drizzle",
                },
                {
                  label: "React Router",
                  link: "/cloudflare/frontend/react-router",
                },
                { label: "Vue", link: "/cloudflare/frontend/vue" },
                {
                  label: "SolidStart",
                  link: "/cloudflare/frontend/solidstart",
                },
                { label: "Astro", link: "/cloudflare/frontend/astro" },
                { label: "Nuxt", link: "/cloudflare/frontend/nuxt" },
              ],
            },
            {
              label: "APIs",
              items: [
                {
                  label: "Schemaless RPC",
                  link: "/cloudflare/apis/schemaless-rpc",
                },
                { label: "Effect RPC", link: "/cloudflare/apis/effect-rpc" },
                {
                  label: "Effect HTTP",
                  link: "/cloudflare/apis/effect-http-api",
                },
              ],
            },
            {
              label: "Data",
              items: [
                { label: "D1", link: "/cloudflare/data/d1" },
                { label: "KV", link: "/cloudflare/data/kv" },
                { label: "R2", link: "/cloudflare/data/r2" },
                { label: "Hyperdrive", link: "/cloudflare/data/hyperdrive" },
                { label: "Drizzle ORM", link: "/cloudflare/data/drizzle" },
                {
                  label: "Shared database",
                  link: "/cloudflare/data/shared-database",
                },
                {
                  label: "Branch from a shared database",
                  link: "/cloudflare/data/branch-from-shared-database",
                },
                { label: "Artifacts", link: "/cloudflare/data/artifacts" },
              ],
            },
            {
              label: "Messaging & events",
              items: [
                { label: "Queues", link: "/cloudflare/messaging/queues" },
                { label: "Cron triggers", link: "/cloudflare/messaging/cron" },
                {
                  label: "GitHub events",
                  link: "/cloudflare/messaging/github-events",
                },
              ],
            },
            {
              label: "Email",
              items: [
                { label: "Email", link: "/cloudflare/email" },
                {
                  label: "Send & receive email",
                  link: "/cloudflare/email/send-and-receive",
                },
              ],
            },
            {
              label: "AI",
              items: [
                { label: "AI Gateway", link: "/cloudflare/ai/ai-gateway" },
                {
                  label: "AI Search (AutoRAG)",
                  link: "/cloudflare/ai/ai-search",
                },
                { label: "Effect AI", link: "/cloudflare/ai/effect-ai" },
                { label: "Vectorize", link: "/cloudflare/ai/vectorize" },
                {
                  label: "Release agent",
                  link: "/cloudflare/ai/release-agent",
                },
              ],
            },
            {
              label: "Security & secrets",
              items: [
                {
                  label: "Secrets & env",
                  link: "/cloudflare/security/secrets-env",
                },
                {
                  label: "Secrets Store",
                  link: "/cloudflare/security/secrets-store",
                },
                { label: "Turnstile", link: "/cloudflare/security/turnstile" },
              ],
            },
            {
              label: "Observability",
              items: [
                {
                  label: "Axiom telemetry",
                  link: "/cloudflare/observability/axiom-observability",
                },
                {
                  label: "Analytics Engine",
                  link: "/cloudflare/observability/analytics-engine",
                },
              ],
            },
            {
              label: "Networking",
              items: [
                {
                  label: "Domains & DNS",
                  link: "/cloudflare/networking/domains",
                },
                {
                  label: "Custom domains & routes",
                  link: "/cloudflare/networking/custom-domains",
                },
                { label: "Tunnel", link: "/cloudflare/networking/tunnel" },
              ],
            },
            providerResourcesEntry("Cloudflare"),
          ],
        },
        {
          label: "AWS",
          items: [
            { label: "Overview", link: "/aws" },
            { label: "Setup", link: "/aws/setup" },
            {
              label: "Tutorial",
              autogenerate: { directory: "aws/tutorial" },
            },
            {
              label: "Compute",
              items: [
                {
                  label: "Choosing a runtime",
                  link: "/aws/compute/choosing-a-runtime",
                },
                { label: "Lambda", link: "/aws/compute/lambda" },
                { label: "ECS", link: "/aws/compute/ecs" },
                { label: "EC2", link: "/aws/compute/ec2" },
                { label: "EKS", link: "/aws/compute/eks" },
                { label: "Lambda MicroVMs", link: "/aws/compute/microvms" },
              ],
            },
            {
              label: "Frontend",
              items: [
                { label: "Websites", link: "/aws/frontend/websites" },
                { label: "Static site", link: "/aws/frontend/static-site" },
              ],
            },
            {
              label: "APIs",
              items: [
                {
                  label: "Schemaless RPC",
                  link: "/aws/apis/schemaless-rpc",
                },
                { label: "Effect RPC", link: "/aws/apis/effect-rpc" },
                {
                  label: "Effect HTTP",
                  link: "/aws/apis/effect-http-api",
                },
                { label: "API Gateway", link: "/aws/apis/api-gateway" },
              ],
            },
            {
              label: "Data",
              items: [
                { label: "DynamoDB", link: "/aws/data/dynamodb" },
                { label: "S3", link: "/aws/data/s3" },
                { label: "RDS & Aurora", link: "/aws/data/rds" },
              ],
            },
            {
              label: "Messaging & events",
              items: [
                { label: "SQS", link: "/aws/messaging/sqs" },
                { label: "SNS", link: "/aws/messaging/sns" },
                { label: "Kinesis", link: "/aws/messaging/kinesis" },
                {
                  label: "EventBridge & Scheduler",
                  link: "/aws/messaging/eventbridge",
                },
                {
                  label: "DynamoDB Streams",
                  link: "/aws/messaging/dynamodb-streams",
                },
                { label: "S3 events", link: "/aws/messaging/s3-events" },
              ],
            },
            {
              label: "Security & secrets",
              items: [
                { label: "Secrets & env", link: "/aws/security/secrets-env" },
              ],
            },
            {
              label: "Observability",
              items: [
                { label: "CloudWatch", link: "/aws/observability/cloudwatch" },
              ],
            },
            {
              label: "Networking",
              items: [
                { label: "VPC & networking", link: "/aws/networking" },
                {
                  label: "Custom domains",
                  link: "/aws/networking/custom-domains",
                },
              ],
            },
            providerResourcesEntry("AWS"),
          ],
        },
        {
          label: "PlanetScale",
          items: [
            { label: "Overview", link: "/planetscale" },
            { label: "Setup", link: "/planetscale/setup" },
            {
              label: "Data",
              items: [
                { label: "Postgres", link: "/planetscale/data/postgres" },
                { label: "MySQL", link: "/planetscale/data/mysql" },
                { label: "Migrations", link: "/planetscale/data/migrations" },
                { label: "Credentials", link: "/planetscale/data/credentials" },
                { label: "Backups", link: "/planetscale/data/backups" },
              ],
            },
            {
              label: "Guides",
              items: [
                {
                  label: "Preview branches per PR",
                  link: "/planetscale/guides/preview-branches",
                },
                {
                  label: "Drizzle ORM",
                  link: "/planetscale/guides/drizzle",
                },
              ],
            },
            providerResourcesEntry("Planetscale"),
          ],
        },
        {
          label: "Neon",
          items: [
            { label: "Overview", link: "/neon" },
            { label: "Setup", link: "/neon/setup" },
            {
              label: "Data",
              items: [
                { label: "Branching", link: "/neon/data/branching" },
                { label: "Connections", link: "/neon/data/connections" },
                { label: "Migrations", link: "/neon/data/migrations" },
              ],
            },
            {
              label: "Guides",
              items: [
                {
                  label: "Preview branches per PR",
                  link: "/neon/guides/preview-branches",
                },
                { label: "Drizzle ORM", link: "/neon/guides/drizzle" },
              ],
            },
            providerResourcesEntry("Neon"),
          ],
        },
        {
          label: "Axiom",
          items: [
            { label: "Overview", link: "/axiom" },
            { label: "Setup", link: "/axiom/setup" },
            {
              label: "Data",
              items: [
                { label: "Datasets & ingest", link: "/axiom/data/ingest" },
              ],
            },
            {
              label: "Guides",
              items: [
                { label: "Alerting", link: "/axiom/guides/alerting" },
                { label: "Dashboards", link: "/axiom/guides/dashboards" },
                { label: "Annotations", link: "/axiom/guides/annotations" },
              ],
            },
            providerResourcesEntry("Axiom"),
          ],
        },
        {
          label: "GitHub",
          items: [
            { label: "Overview", link: "/github" },
            { label: "Setup", link: "/github/setup" },
            { label: "Repositories", link: "/github/repository" },
            {
              label: "Actions secrets & variables",
              link: "/github/actions-config",
            },
            { label: "Webhooks & events", link: "/github/events" },
            providerResourcesEntry("GitHub"),
          ],
        },
        {
          label: "Docker",
          items: [
            { label: "Overview", link: "/docker" },
            { label: "Setup", link: "/docker/setup" },
            { label: "Run local services", link: "/docker/local-services" },
            { label: "Build & push images", link: "/docker/build-and-push" },
            providerResourcesEntry("Docker"),
          ],
        },
        {
          label: "Kubernetes",
          items: [
            { label: "Overview", link: "/kubernetes" },
            { label: "Setup", link: "/kubernetes/setup" },
            {
              label: "How objects deploy",
              link: "/kubernetes/objects-as-bindings",
            },
            providerResourcesEntry("Kubernetes"),
          ],
        },
        {
          label: "Drizzle",
          items: [
            { label: "Overview", link: "/drizzle" },
            {
              label: "Migrations as resources",
              link: "/drizzle/migrations",
            },
            providerResourcesEntry("Drizzle"),
          ],
        },
        {
          label: "Command",
          items: [
            { label: "Overview", link: "/command" },
            {
              label: "Memoized builds & commands",
              link: "/command/memoization",
            },
            { label: "Dev servers", link: "/command/dev-servers" },
            providerResourcesEntry("Command"),
          ],
        },
        providersSidebarEntry(),
      ],
      // starlight-blog feeds this many posts into the sidebar's "Recent"
      // group, which `src/blog-sidebar.ts` re-buckets into Releases/Posts.
      // We want every post listed, so set it effectively unlimited.
      plugins: [starlightBlog({ recentPostCount: Number.MAX_SAFE_INTEGER })],
      routeMiddleware: ["./src/blog-sidebar.ts", "./src/docs-tabs-sidebar.ts"],
    }),
    mdx(),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
