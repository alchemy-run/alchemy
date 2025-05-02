import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Context } from "../context.js";
import { Folder } from "../fs/folder.js";
import { StaticJsonFile } from "../fs/static-json-file.js";
import { StaticTextFile } from "../fs/static-text-file.js";
import { StaticTypeScriptFile } from "../fs/static-typescript-file.js";
import { Resource } from "../resource.js";
import { ShadcnUI } from "./shadcn.js";

const execAsync = promisify(exec);

/**
 * Type of integrations that can be added to an Astro project
 */
export type AstroIntegration =
  | "react"
  | "preact"
  | "vue"
  | "svelte"
  | "solid"
  | "lit"
  | "tailwind"
  | "mdx"
  | "sitemap"
  | "partytown"
  | "markdoc";

/**
 * Properties for creating an Astro project
 */
export interface AstroProjectProps {
  /**
   * The name/path of the project
   */
  name: string;

  /**
   * The title of the site
   * @default "Astro Site"
   */
  title?: string;

  /**
   * The description of the site
   * @default "Welcome to my Astro site"
   */
  description?: string;

  /**
   * The directory to initialize the project in.
   * @default {@link name}
   */
  dir?: string;

  /**
   * The integrations to add to the project
   * @default []
   */
  integrations?: AstroIntegration[];

  /**
   * The TypeScript configuration
   */
  tsconfig?: {
    /**
     * Extends from this TypeScript configuration
     */
    extends?: string;

    /**
     * References to add to the tsconfig
     */
    references?: string[];

    /**
     * Compiler options to add to the tsconfig
     */
    compilerOptions?: Record<string, any>;
  };

  /**
   * Whether to delete the project folder during the delete phase
   * @default true
   */
  delete?: boolean;

  /**
   * Add Shadcn UI to the project
   * @default false
   */
  shadcn?: {
    /**
     * The base color to use
     * @default "neutral"
     */
    baseColor?: "neutral" | "gray" | "zinc" | "stone" | "slate";

    /**
     * Use default configuration
     * @default false
     */
    defaults?: boolean;

    /**
     * Force overwrite of existing configuration
     * @default false
     */
    force?: boolean;

    /**
     * Mute output
     * @default false
     */
    silent?: boolean;

    /**
     * Use the src directory when creating a new project
     * @default true
     */
    srcDir?: boolean;

    /**
     * Use css variables for theming
     * @default true
     */
    cssVariables?: boolean;

    /**
     * The components to add
     */
    components?: string[];
  };

  /**
   * The dependencies to install
   */
  dependencies?: Record<string, string>;

  /**
   * The dev dependencies to install
   */
  devDependencies?: Record<string, string>;

  /**
   * Additional scripts to add to package.json
   */
  scripts?: Record<string, string>;
}

/**
 * Astro project resource
 */
export interface AstroProject extends AstroProjectProps, Resource {
  /**
   * The name/path of the project
   */
  name: string;
}

/**
 * Creates a new Astro project
 *
 * @example
 * // Create a basic Astro project
 * const basicProject = await AstroProject("my-astro-app", {
 *   title: "My Astro Site",
 *   description: "Built with Alchemy"
 * });
 *
 * @example
 * // Create an Astro project with React and Tailwind
 * const reactProject = await AstroProject("astro-react", {
 *   title: "Astro + React",
 *   integrations: ["react", "tailwind"]
 * });
 *
 * @example
 * // Create an Astro project with Shadcn UI
 * const shadcnProject = await AstroProject("astro-shadcn", {
 *   title: "Astro with Shadcn UI",
 *   integrations: ["react", "tailwind"],
 *   shadcn: {
 *     baseColor: "zinc",
 *     components: ["button", "card", "input"]
 *   }
 * });
 */
export const AstroProject = Resource(
  "project::AstroProject",
  {
    alwaysUpdate: true,
  },
  async function (
    this: Context<AstroProject>,
    id: string,
    props: AstroProjectProps,
  ): Promise<AstroProject> {
    const dir = props.dir ?? props.name;

    if (this.phase === "delete") {
      try {
        if (props.delete !== false) {
          if (await fs.stat(dir).catch(() => null)) {
            await execAsync(`rm -rf ${dir}`);
          }
        }
      } catch (error) {
        console.error(`Error deleting project ${id}:`, error);
      }
      return this.destroy();
    }

    const cwd = path.resolve(process.cwd(), dir);

    // Create the project directory
    await Folder("project-dir", {
      path: dir,
      delete: true,
    });

    await Folder(".astro", {
      path: dir,
      delete: true,
      clean: true,
    });

    await setupProject(props);

    return this(props);

    /**
     * Set up the Astro project structure and configuration
     */
    async function setupProject(props: AstroProjectProps) {
      // Create project structure
      await ProjectStructure();

      // Set up package.json
      await StaticJsonFile(path.join(dir, "package.json"), {
        name: props.name,
        type: "module",
        version: "0.0.1",
        scripts: {
          dev: "astro dev",
          start: "astro dev",
          build: "astro build",
          preview: "astro preview",
          astro: "astro",
          ...props.scripts,
        },
        dependencies: props.dependencies || {},
        devDependencies: props.devDependencies || {},
      });

      // Set up tsconfig.json
      await StaticJsonFile(path.join(dir, "tsconfig.json"), {
        extends: props.tsconfig?.extends || "astro/tsconfigs/strict",
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@/*": ["./src/*"],
          },
          jsx: "react-jsx",
          jsxImportSource: "react",
          ...props.tsconfig?.compilerOptions,
        },
        include: ["src/**/*.ts", "src/**/*.tsx", "src/**/*.astro"],
        references: props.tsconfig?.references?.map((path) => ({ path })),
      });

      // Set up astro.config.mjs
      await AstroConfig();

      // Set up initial files
      await InitialFiles();

      // Install integrations
      if (props.integrations && props.integrations.length > 0) {
        await InstallIntegrations();
      }

      // Install dependencies
      await InstallDependencies();

      // Set up Shadcn if requested
      if (props.shadcn) {
        await ShadcnUI(id, {
          ...props.shadcn,
          cwd: dir,
        });
      }
    }

    /**
     * Create the basic project structure
     */
    async function ProjectStructure() {
      const folderPaths = [
        "src",
        "src/components",
        "src/layouts",
        "src/pages",
        "public",
      ];

      for (const folderPath of folderPaths) {
        await Folder(`${dir}-${folderPath}`, {
          path: path.join(dir, folderPath),
        });
      }
    }

    /**
     * Set up astro.config.mjs
     */
    async function AstroConfig() {
      const integrations = [];
      const vitePlugins = [];

      // Add imports and integrations
      const configImports = ['import { defineConfig } from "astro/config";'];

      if (props.integrations?.includes("react")) {
        configImports.push('import react from "@astrojs/react";');
        integrations.push("react()");
      }

      if (props.integrations?.includes("preact")) {
        configImports.push('import preact from "@astrojs/preact";');
        integrations.push("preact()");
      }

      if (props.integrations?.includes("vue")) {
        configImports.push('import vue from "@astrojs/vue";');
        integrations.push("vue()");
      }

      if (props.integrations?.includes("svelte")) {
        configImports.push('import svelte from "@astrojs/svelte";');
        integrations.push("svelte()");
      }

      if (props.integrations?.includes("solid")) {
        configImports.push('import solid from "@astrojs/solid-js";');
        integrations.push("solid()");
      }

      if (props.integrations?.includes("lit")) {
        configImports.push('import lit from "@astrojs/lit";');
        integrations.push("lit()");
      }

      if (props.integrations?.includes("tailwind")) {
        configImports.push('import tailwindcss from "@tailwindcss/vite";');
        vitePlugins.push("tailwindcss()");
      }

      if (props.integrations?.includes("mdx")) {
        configImports.push('import mdx from "@astrojs/mdx";');
        integrations.push("mdx()");
      }

      if (props.integrations?.includes("sitemap")) {
        configImports.push('import sitemap from "@astrojs/sitemap";');
        integrations.push("sitemap()");
      }

      if (props.integrations?.includes("partytown")) {
        configImports.push('import partytown from "@astrojs/partytown";');
        integrations.push("partytown()");
      }

      if (props.integrations?.includes("markdoc")) {
        configImports.push('import markdoc from "@astrojs/markdoc";');
        integrations.push("markdoc()");
      }

      const integrationsStr = integrations.length
        ? `\n  integrations: [${integrations.join(", ")}],`
        : "";

      const vitePluginsStr = vitePlugins.length
        ? `\n  vite: {\n    plugins: [${vitePlugins.join(", ")}]\n  },`
        : "";

      return StaticTypeScriptFile(
        path.join(dir, "astro.config.ts"),
        `${configImports.join("\n")}

// https://astro.build/config
export default defineConfig({${integrationsStr}${vitePluginsStr}
  site: "https://example.com",
  output: "static"
});`,
      );
    }

    /**
     * Create initial files for the project
     */
    async function InitialFiles() {
      // Create .gitignore
      await StaticTextFile(
        path.join(dir, ".gitignore"),
        `# build output
dist/
.output/

# dependencies
node_modules/

# logs
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# environment variables
.env
.env.production

# macOS-specific files
.DS_Store
.astro/
`,
      );

      // Create .env.d.ts
      await StaticTextFile(
        path.join(dir, "src", "env.d.ts"),
        `/// <reference types="astro/client" />
`,
      );

      // Create a basic layout
      await StaticTextFile(
        path.join(dir, "src", "layouts", "Layout.astro"),
        `---
interface Props {
  title: string;
  description?: string;
}

const { title, description = "Welcome to my Astro site" } = Astro.props;
---

<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="generator" content={Astro.generator} />
    <meta name="description" content={description} />
    <title>{title}</title>
  </head>
  <body>
    <slot />
  </body>
</html>

<style is:global>
  :root {
    --accent: 124, 58, 237;
    --accent-gradient: linear-gradient(45deg, rgb(var(--accent)), #da62c4 30%, white 60%);
  }
  html {
    font-family: system-ui, sans-serif;
    background-color: #f6f6f6;
  }
  code {
    font-family: Menlo, Monaco, Lucida Console, Liberation Mono, DejaVu Sans Mono,
      Bitstream Vera Sans Mono, Courier New, monospace;
  }
</style>
`,
      );

      // Create a basic index page
      await StaticTextFile(
        path.join(dir, "src", "pages", "index.astro"),
        `---
import Layout from '../layouts/Layout.astro';
---

<Layout title="${props.title || "Astro Site"}" description="${props.description || "Welcome to my Astro site"}">
  <main>
    <h1><span class="text-gradient">Astro</span> Site</h1>
    <p class="instructions">
      To get started, edit <code>src/pages/index.astro</code> and save to see your changes.
    </p>
  </main>
</Layout>

<style>
  main {
    margin: auto;
    padding: 1.5rem;
    max-width: 60ch;
  }
  h1 {
    font-size: 3rem;
    font-weight: 800;
    margin: 0;
  }
  .text-gradient {
    background-image: var(--accent-gradient);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-size: 400%;
    background-position: 0%;
  }
  .instructions {
    line-height: 1.6;
    margin: 1rem 0;
    border: 1px solid rgba(var(--accent), 25%);
    background-color: white;
    padding: 1rem;
    border-radius: 0.4rem;
  }
  .instructions code {
    font-size: 0.875em;
    font-weight: bold;
    background: rgba(var(--accent), 12%);
    color: rgb(var(--accent));
    border-radius: 4px;
    padding: 0.3em 0.45em;
  }
</style>
`,
      );

      // Create public/favicon.svg
      await StaticTextFile(
        path.join(dir, "public", "favicon.svg"),
        `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 36 36">
  <path fill="#000" d="M22.25 4h-8.5a1 1 0 0 0-.96.73l-5.54 19.4a.5.5 0 0 0 .62.62l5.05-1.44a2 2 0 0 0 1.38-1.4l3.22-11.66a.5.5 0 0 1 .96 0l3.22 11.67a2 2 0 0 0 1.38 1.39l5.05 1.44a.5.5 0 0 0 .62-.62l-5.54-19.4a1 1 0 0 0-.96-.73Z"/>
  <path fill="url(#gradient)" d="M18 28a7.63 7.63 0 0 1-5-2c-1.4 2.1-.35 4.35.6 5.55.14.17.41.07.47-.15.44-1.8 2.93-1.22 2.93.6 0 2.28.87 3.4 1.72 3.81.34.16.59-.2.49-.56-.31-1.05-.29-2.46 1.29-3.25 3-1.5 3.17-4.83 2.5-6-.67.67-2.6 2-5 2Z"/>
  <defs>
    <linearGradient id="gradient" x1="16" x2="16" y1="32" y2="24" gradientUnits="userSpaceOnUse">
      <stop stop-color="#FF1639"/>
      <stop offset="1" stop-color="#FF1639" stop-opacity="0"/>
    </linearGradient>
  </defs>
</svg>
`,
      );
    }

    /**
     * Install Astro integrations
     */
    async function InstallIntegrations() {
      const exec = (command: string) => execAsync(command, { cwd });
      const integrationPackages = [];

      for (const integration of props.integrations!) {
        switch (integration) {
          case "react":
            integrationPackages.push("@astrojs/react", "react", "react-dom");
            break;
          case "preact":
            integrationPackages.push("@astrojs/preact", "preact");
            break;
          case "vue":
            integrationPackages.push("@astrojs/vue", "vue");
            break;
          case "svelte":
            integrationPackages.push("@astrojs/svelte", "svelte");
            break;
          case "solid":
            integrationPackages.push("@astrojs/solid-js", "solid-js");
            break;
          case "lit":
            integrationPackages.push("@astrojs/lit", "lit");
            break;
          case "tailwind":
            integrationPackages.push("@tailwindcss/vite", "tailwindcss");

            // Create a base.css file with @tailwind directives
            await Folder(path.join(dir, "src", "styles"));

            await StaticTextFile(
              path.join(dir, "src", "styles", "global.css"),
              `@tailwind base;
@tailwind components;
@tailwind utilities;
`,
            );
            break;
          case "mdx":
            integrationPackages.push("@astrojs/mdx");
            break;
          case "sitemap":
            integrationPackages.push("@astrojs/sitemap");
            break;
          case "partytown":
            integrationPackages.push("@astrojs/partytown");
            break;
          case "markdoc":
            integrationPackages.push("@astrojs/markdoc");
            break;
        }
      }

      if (integrationPackages.length > 0) {
        await exec(`bun add astro ${integrationPackages.join(" ")}`);
      }
    }

    /**
     * Install dependencies
     */
    async function InstallDependencies() {
      const exec = (command: string) => execAsync(command, { cwd });

      // Install Astro and general dependencies
      await exec("bun add astro");

      // Install dev dependencies
      const devDepsEntries = Object.entries(props.devDependencies || {});
      if (devDepsEntries.length > 0) {
        const devDepsArg = devDepsEntries
          .map(([name, version]) => `${name}@${version}`)
          .join(" ");
        await exec(`bun add -D ${devDepsArg}`);
      }

      // Install regular dependencies
      const depsEntries = Object.entries(props.dependencies || {});
      if (depsEntries.length > 0) {
        const depsArg = depsEntries
          .map(([name, version]) => `${name}@${version}`)
          .join(" ");
        await exec(`bun add ${depsArg}`);
      }
    }
  },
);
