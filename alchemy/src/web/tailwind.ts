import { exec } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { Context } from "../context.js";
import { Folder } from "../fs/folder.js";
import { StaticTextFile } from "../fs/static-text-file.js";
import { Resource } from "../resource.js";

const execAsync = promisify(exec);

/**
 * Framework types supported by the Tailwind resource
 */
export type TailwindFramework = "vite" | "astro" | "next" | "standalone";

/**
 * Properties for Tailwind configuration
 */
export interface TailwindConfigProps {
  /**
   * The working directory where Tailwind should be installed
   */
  cwd: string;

  /**
   * The framework being used (determines which dependencies to install)
   * @default "standalone"
   */
  framework?: TailwindFramework;

  /**
   * The path to the CSS file where Tailwind directives should be added
   * If not provided, a new file will be created at src/styles/base.css
   */
  cssPath?: string;

  /**
   * Custom additional packages to install with Tailwind
   */
  additionalPackages?: string[];
}

/**
 * Tailwind configuration resource
 */
export interface TailwindConfig
  extends TailwindConfigProps,
    Resource<"config::TailwindConfig"> {
  /**
   * The working directory where Tailwind is installed
   */
  cwd: string;
}

/**
 * Installs and configures Tailwind CSS for a project
 *
 * @example
 * // Install Tailwind for a Vite project
 * const tailwind = await TailwindConfig("vite-tailwind", {
 *   cwd: "my-vite-app",
 *   framework: "vite"
 * });
 *
 * @example
 * // Install Tailwind for an Astro project
 * const tailwind = await TailwindConfig("astro-tailwind", {
 *   cwd: "my-astro-app",
 *   framework: "astro"
 * });
 *
 * @example
 * // Install Tailwind as standalone with a custom CSS path
 * const tailwind = await TailwindConfig("custom-tailwind", {
 *   cwd: "my-project",
 *   cssPath: "src/css/main.css",
 *   additionalPackages: ["@tailwindcss/typography", "@tailwindcss/forms"]
 * });
 */
export const TailwindConfig = Resource(
  "config::TailwindConfig",
  async function (
    this: Context<TailwindConfig>,
    id: string,
    props: TailwindConfigProps,
  ): Promise<TailwindConfig> {
    if (this.phase === "delete") {
      // Nothing to clean up specifically for Tailwind
      return this.destroy();
    }

    const framework = props.framework || "standalone";

    // Setup execAsync with the correct cwd
    const exec = (command: string) => execAsync(command, { cwd: props.cwd });

    // Install Tailwind and framework-specific dependencies
    await installTailwindDependencies(framework);

    // Create CSS file with Tailwind directives
    await createTailwindCssFile();

    return this({
      ...props,
      framework: framework,
    });

    /**
     * Install Tailwind and framework-specific dependencies
     */
    async function installTailwindDependencies(framework: TailwindFramework) {
      const basePackages = ["tailwindcss", "postcss", "autoprefixer"];

      // Add framework-specific packages
      const frameworkPackages = getFrameworkPackages(framework);

      // Add custom additional packages
      const additionalPackages = props.additionalPackages || [];

      // Combine all packages
      const allPackages = [
        ...basePackages,
        ...frameworkPackages,
        ...additionalPackages,
      ];

      // Install all packages
      await exec(`bun add -D ${allPackages.join(" ")}`);
    }

    /**
     * Get framework-specific packages for Tailwind
     */
    function getFrameworkPackages(framework: TailwindFramework): string[] {
      switch (framework) {
        case "vite":
          return ["@tailwindcss/vite"];
        case "astro":
          return ["@astrojs/tailwind"];
        case "next":
          return [];
        default:
          return [];
      }
    }

    /**
     * Create or update CSS file with Tailwind directives
     */
    async function createTailwindCssFile() {
      const tailwindDirectives = `@import 'tailwindcss';`;

      // Determine CSS file path
      const cssPath =
        props.cssPath || path.join(props.cwd, "src", "styles", "global.css");

      // Create directory structure if needed
      const cssDir = path.dirname(cssPath);
      await Folder(path.join(id, "css-dir"), {
        path: cssDir,
      });

      // Create CSS file with Tailwind directives
      await StaticTextFile(cssPath, tailwindDirectives);
    }
  },
);
