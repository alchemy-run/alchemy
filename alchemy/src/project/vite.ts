import { exec } from "child_process";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";
import type { Context } from "../context";
import { Resource } from "../resource";
import { rm } from "../util/rm";
const execAsync = promisify(exec);

type ViteTemplate =
  | "vanilla"
  | "vanilla-ts"
  | "vue"
  | "vue-ts"
  | "react"
  | "react-ts"
  | "react-swc"
  | "react-swc-ts"
  | "preact"
  | "preact-ts"
  | "lit"
  | "lit-ts"
  | "svelte"
  | "svelte-ts"
  | "solid"
  | "solid-ts"
  | "qwik"
  | "qwik-ts";

export interface ViteProjectProps {
  /**
   * The name/path of the project
   */
  name: string;
  /**
   * The Vite template to use
   */
  template: ViteTemplate;
  /**
   * The extends to add to the tsconfig.json file
   */
  extends?: string;
  /**
   * The references to add to the tsconfig.json file
   */
  references?: string[];
  /**
   * @default false
   */
  tailwind?: boolean;
  /**
   * Force overwrite the project config tfiles during the update phase
   *
   * @default false
   */
  overwrite?: boolean;
}

export interface ViteProject extends ViteProjectProps, Resource {
  /**
   * The name/path of the project
   */
  name: string;
}

export const ViteProject = Resource(
  "project::ViteProject",
  async function (
    this: Context<ViteProject>,
    id: string,
    props: ViteProjectProps,
  ): Promise<ViteProject> {
    if (this.phase === "delete") {
      try {
        if (await fs.exists(props.name)) {
          // TODO: OS agnostic - fs.rm is slow to delete node_modules/
          await execAsync("rm -rf " + props.name);
        }
      } catch (error) {
        console.error(`Error deleting project ${id}:`, error);
      }
      return this.destroy();
    }

    if (this.phase === "update") {
      if (props.overwrite) {
        await modifyConfig(props);
      } else {
        console.warn(
          "ViteProject does not support updates - the project must be recreated to change the template",
        );
      }
    } else {
      // Create phase
      await execAsync(`bun create vite ${id} --template ${props.template}`);

      await modifyConfig(props);
    }

    return this(props);
  },
);

async function modifyConfig(props: ViteProjectProps) {
  if (props.tailwind) {
    await execAsync(`bun add tailwindcss @tailwindcss/vite`);

    await fs.writeFile(
      path.join(props.name, "vite.config.ts"),
      `import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
});`,
    );

    // Add Tailwind CSS import to index.css
    const indexCssPath = path.join(props.name, "src", "index.css");
    const currentCss = await fs.readFile(indexCssPath, "utf-8");
    if (!currentCss.includes('@import "tailwindcss";')) {
      await fs.writeFile(
        indexCssPath,
        '@import "tailwindcss";\n\n' + currentCss,
      );
    }
  }

  await Promise.all([
    rm(path.join(props.name, "tsconfig.app.json")),
    rm(path.join(props.name, "tsconfig.node.json")),
    fs.writeFile(
      path.join(props.name, "tsconfig.json"),
      JSON.stringify(
        {
          extends: props.extends,
          compilerOptions: {
            types: ["@cloudflare/workers-types"],
            allowImportingTsExtensions: true,
            jsx: "react-jsx",
          },
          include: ["vite/*.ts", "src/**/*.ts", "src/**/*.tsx", "src/env.d.ts"],
          references: props.references?.map((path) => ({ path })),
        },
        null,
        2,
      ),
    ),
  ]);
}
