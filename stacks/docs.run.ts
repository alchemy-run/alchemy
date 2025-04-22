import path from "node:path";

import "../alchemy/src/fs";
import "../alchemy/src/web/vitepress";

import alchemy from "../alchemy/src";
import { CopyFile } from "../alchemy/src/fs/copy-file";
import { Folder } from "../alchemy/src/fs/folder";
import { Providers } from "../alchemy/src/internal/docs/providers";
import { VitepressProject } from "../alchemy/src/web/vitepress";
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
});

await app.finalize();
