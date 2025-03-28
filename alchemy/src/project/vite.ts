import { exec } from "child_process";
import fs, { rm } from "fs/promises";
import path from "path";
import { promisify } from "util";
import type { Context } from "../context";
import { Resource } from "../resource";
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
          await rm(props.name, { recursive: true, force: true });
        }
      } catch (error) {
        console.error(`Error deleting project ${id}:`, error);
      }
      return this.destroy();
    }

    if (this.phase === "update") {
      console.warn(
        "ViteProject does not support updates - the project must be recreated to change the template",
      );
    } else {
      // Create phase
      await execAsync(`bun create vite ${id} --template ${props.template}`);

      await Promise.all([
        fs.rm(path.join(props.name, "tsconfig.app.json")),
        fs.rm(path.join(props.name, "tsconfig.node.json")),
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
              include: [
                "vite/*.ts",
                "src/**/*.ts",
                "src/**/*.tsx",
                "src/env.d.ts",
              ],
              references: props.references?.map((path) => ({ path })),
            },
            null,
            2,
          ),
        ),
      ]);
    }

    return this(props);
  },
);
