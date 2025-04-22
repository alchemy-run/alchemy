import path from "node:path";

import "../alchemy/src/fs";
import "../alchemy/src/web/vitepress";

import alchemy from "../alchemy/src";
import { CopyFile } from "../alchemy/src/fs/copy-file";
import { Folder } from "../alchemy/src/fs/folder";
import { Providers } from "../alchemy/src/internal/docs/providers";
import {
  processFrontmatterFiles,
  VitePressConfig,
  VitepressProject,
} from "../alchemy/src/web/vitepress";
import env from "./env";

const app = await alchemy("alchemy:docs", env);

const project = await VitepressProject("vitepress", {
  name: "alchemy-web",
  delete: true,
});

const docs = await Folder("docs", {
  path: path.join(project.dir, "docs"),
});

const [pub, blogs, guides, providers, conceptsDir] = await Promise.all([
  Folder("public", {
    path: path.join(project.dir, "public"),
  }),
  Folder("blogs", {
    path: path.join(project.dir, "blogs"),
  }),
  Folder("guides", {
    path: path.join(docs.path, "guides"),
  }),
  Folder("providers", {
    path: path.join(docs.path, "providers"),
  }),
  Folder("concepts", {
    path: path.join(docs.path, "concepts"),
  }),
]);

await CopyFile("docs-public-alchemist", {
  src: path.join(process.cwd(), "public", "alchemist.webp"),
  dest: path.join(pub.path, "alchemist.webp"),
});

const filterIdx = process.argv.findIndex((arg) => arg === "--filter");

await VitePressConfig({
  cwd: project.dir,
  title: "Alchemy",
  description: "Alchemy Docs",
  head: [
    ["link", { rel: "icon", type: "image/png", href: "/potion.png" }],
    // Open Graph
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "Alchemy" }],
    ["meta", { property: "og:description", content: "Alchemy Docs" }],
    ["meta", { property: "og:url", content: "https://alchemy.run" }],
    // [
    //   "meta",
    //   {
    //     property: "og:image",
    //     content: "https://alchemy.run/alchemy-unfurl.png",
    //   },
    // ],
    // Twitter Card (similar to Open Graph)
    // ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:title", content: "Alchemy" }],
    ["meta", { name: "twitter:description", content: "Alchemy Docs" }],
    // [
    //   "meta",
    //   {
    //     name: "twitter:image",
    //     content: "https://alchemy.run/alchemy-unfurl.png",
    //   },
    // ],
  ],
  themeConfig: {
    nav: [
      { text: "Home", link: "/" },
      { text: "Docs", link: "/docs/getting-started" },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/sam-goodwin/alchemy" },
      { icon: "discord", link: "https://discord.gg/jwKw8dBJdN" },
      { icon: "x", link: "https://twitter.com/samgoodwin89" },
    ],
    sidebar: [
      {
        text: "Get Started",
        link: "/docs/getting-started",
      },
      {
        text: "What is Alchemy?",
        link: "/docs/what-is-alchemy",
      },
      {
        text: "Concepts",
        collapsed: false,
        items: await processFrontmatterFiles(
          conceptsDir.path,
          "/docs/concepts"
        ),
      },
      {
        text: "Guides",
        collapsed: false,
        items: await processFrontmatterFiles(guides.path, "/docs/guides"),
      },
      {
        text: "Providers",
        collapsed: false,
        items: (
          await Providers({
            srcDir: path.join("alchemy", "src"),
            outDir: providers.path,
            // anthropic throttles are painful, so we'll run them serially
            parallel: false,
            filter:
              process.argv[filterIdx + 1] === "true"
                ? true
                : filterIdx > -1
                  ? isNaN(parseInt(process.argv[filterIdx + 1]))
                    ? false
                    : parseInt(process.argv[filterIdx + 1])
                  : false,
          })
        )
          .sort((a, b) => a.provider.localeCompare(b.provider))
          .map((p) => ({
            text: p.provider,
            collapsed: true,
            items: p.documents
              .sort((a, b) => a.title.localeCompare(b.title))
              .map((doc) => ({
                text: doc.title.replaceAll(" ", ""),
                link: `/docs/providers/${p.provider}/${path.basename(doc.path!, ".md")}`,
              })),
          })),
      },
    ],
  },
});

await app.finalize();
