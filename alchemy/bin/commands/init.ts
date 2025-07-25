import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  outro,
  select,
} from "@clack/prompts";
import * as fs from "fs-extra";
import { resolve } from "node:path";
import pc from "picocolors";
import z from "zod";
import { detectPackageManager } from "../../src/util/detect-package-manager.ts";
import type { DependencyVersionMap } from "../constants.ts";
import { throwWithContext } from "../errors.ts";
import { Project, IndentationText, QuoteKind, Node } from "ts-morph";
import { addPackageDependencies } from "../services/dependencies.ts";
import { t } from "../trpc.ts";
import {
  TemplateSchema,
  type InitContext,
  type TemplateType,
} from "../types.ts";

export const init = t.procedure
  .meta({
    description: "Initialize Alchemy in an existing project",
  })
  .input(
    z.tuple([
      z.object({
        framework: TemplateSchema.optional().describe(
          "Force a specific framework instead of auto-detection",
        ),
        yes: z.boolean().optional().describe("Skip prompts and use defaults"),
      }),
    ]),
  )
  .mutation(async ({ input: [options] }) => {
    try {
      intro(pc.cyan("🧪 Initializing Alchemy in your project"));

      const context = await createInitContext(options);

      if (!context.hasPackageJson) {
        log.warn(
          "No package.json found. Please run in a project with package.json.",
        );
        process.exit(1);
      }

      await checkExistingAlchemyFiles(context);
      await createAlchemyRunFile(context);
      await updatePackageJson(context);
      await updateTsConfig(context);

      displaySuccessMessage(context);
    } catch (_error) {}
  });

async function createInitContext(options: {
  framework?: TemplateType;
  yes?: boolean;
}): Promise<InitContext> {
  const cwd = resolve(process.cwd());
  const packageJsonPath = resolve(cwd, "package.json");
  const hasPackageJson = await fs.pathExists(packageJsonPath);

  let projectName = "my-alchemy-app";
  if (hasPackageJson) {
    try {
      const packageJson = await fs.readJson(packageJsonPath);
      projectName = packageJson.name || "my-alchemy-app";
    } catch (_error) {}
  }

  const useTypeScript = await fs.pathExists(resolve(cwd, "tsconfig.json"));
  const framework =
    options.framework ||
    (await detectFramework(cwd, hasPackageJson, options.yes));
  const packageManager = await detectPackageManager(cwd);

  return {
    cwd,
    framework,
    useTypeScript,
    projectName,
    hasPackageJson,
    packageManager,
  };
}

async function detectFramework(
  cwd: string,
  hasPackageJson: boolean,
  skipPrompts?: boolean,
): Promise<TemplateType> {
  if (!hasPackageJson) {
    return "typescript";
  }

  const detectedFramework = await detectFrameworkFromPackageJson(cwd);

  if (skipPrompts) {
    return detectedFramework;
  }

  const frameworkResult = await select({
    message: "Which framework are you using?",
    options: [
      { label: "TypeScript Worker", value: "typescript" },
      { label: "Vite", value: "vite" },
      { label: "Astro", value: "astro" },
      { label: "React Router", value: "react-router" },
      { label: "SvelteKit", value: "sveltekit" },
      { label: "TanStack Start", value: "tanstack-start" },
      { label: "Redwood SDK", value: "rwsdk" },
      { label: "Nuxt.js", value: "nuxt" },
    ],
    initialValue: detectedFramework,
  });

  if (isCancel(frameworkResult)) {
    cancel(pc.red("Operation cancelled."));
    process.exit(0);
  }

  return frameworkResult;
}

async function detectFrameworkFromPackageJson(
  cwd: string,
): Promise<TemplateType> {
  const packageJsonPath = resolve(cwd, "package.json");

  try {
    const packageJson = await fs.readJson(packageJsonPath);
    const allDeps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
      ...packageJson.peerDependencies,
    };

    if ("rwsdk" in allDeps) return "rwsdk";
    if ("astro" in allDeps) return "astro";
    if ("nuxt" in allDeps) return "nuxt";
    if ("react-router" in allDeps) return "react-router";
    if ("@sveltejs/kit" in allDeps) return "sveltekit";
    if ("@tanstack/react-start" in allDeps) return "tanstack-start";
    if ("vite" in allDeps) return "vite";
    return "typescript";
  } catch (_error) {
    return "typescript";
  }
}

async function checkExistingAlchemyFiles(context: InitContext) {
  const alchemyRunTs = resolve(context.cwd, "alchemy.run.ts");
  const alchemyRunJs = resolve(context.cwd, "alchemy.run.js");

  const tsExists = await fs.pathExists(alchemyRunTs);
  const jsExists = await fs.pathExists(alchemyRunJs);

  if (tsExists || jsExists) {
    const existingFile = tsExists ? "alchemy.run.ts" : "alchemy.run.js";
    const overwriteResult = await confirm({
      message: `${pc.yellow(existingFile)} already exists. Overwrite?`,
      initialValue: false,
    });

    if (isCancel(overwriteResult) || !overwriteResult) {
      cancel(pc.red("Operation cancelled."));
      process.exit(0);
    }
  }
}

function getAlchemyRunContent(context: InitContext): string {
  const templates: Record<TemplateType, string> = {
    typescript: "",
    vite: `import alchemy from "alchemy";
import { Vite } from "alchemy/cloudflare";

const app = await alchemy("${context.projectName}");

export const worker = await Vite("${context.projectName}", {
  command: "${context.packageManager} run build",
  assets: "dist",
  wrangler: false,
});

console.log({
  url: worker.url,
});

await app.finalize();
`,
    astro: `/// <reference types="@types/node" />

import alchemy from "alchemy";
import { Astro } from "alchemy/cloudflare";

const app = await alchemy("${context.projectName}");

export const worker = await Astro("website", {
  command: "bun run build",
});

console.log({
  url: worker.url,
});

await app.finalize();
`,
    "react-router": `/// <reference types="@types/node" />

import alchemy from "alchemy";
import { ReactRouter } from "alchemy/cloudflare";

const app = await alchemy("${context.projectName}");

export const worker = await ReactRouter("website", {
  main: "./workers/app.ts",
  command: "bun run build",
});

console.log({
  url: worker.url,
});

await app.finalize();
`,
    sveltekit: "",
    "tanstack-start": "",
    rwsdk: "",
    nuxt: `/// <reference types="@types/node" />

import alchemy from "alchemy";
import { Nuxt } from "alchemy/cloudflare";

const app = await alchemy("${context.projectName}");

export const worker = await Nuxt("website", {
  command: "bun run build",
});

console.log({
  url: worker.url,
});

await app.finalize();
`,
  };

  return templates[context.framework];
}

async function createAlchemyRunFile(context: InitContext) {
  try {
    const content = getAlchemyRunContent(context);
    const outputFileName = context.useTypeScript
      ? "alchemy.run.ts"
      : "alchemy.run.js";
    const outputPath = resolve(context.cwd, outputFileName);
    await fs.writeFile(outputPath, content, "utf-8");
  } catch (error) {
    throwWithContext(error, "Failed to create alchemy.run file");
  }
}

async function updatePackageJson(context: InitContext) {
  try {
    const devDependencies: DependencyVersionMap[] = ["alchemy"];
    if (context.framework === "nuxt") {
      devDependencies.push("nitro-cloudflare-dev");
    }
    await addPackageDependencies({
      devDependencies,
      projectDir: context.cwd,
    });

    const packageJsonPath = resolve(context.cwd, "package.json");
    const packageJson = await fs.readJson(packageJsonPath);

    if (!packageJson.scripts) {
      packageJson.scripts = {};
    }

    const scripts = {
      deploy: "alchemy deploy",
      destroy: "alchemy destroy",
      "alchemy:dev": "alchemy dev",
    };

    for (const [script, command] of Object.entries(scripts)) {
      if (!packageJson.scripts[script]) {
        packageJson.scripts[script] = command;
      }
    }

    await fs.writeJson(packageJsonPath, packageJson, { spaces: 2 });
  } catch (error) {
    throwWithContext(error, "Failed to update package.json");
  }
}

async function updateTsConfig(context: InitContext) {
  if (context.framework === "astro") {
    await updateAstroProject(context);
    return;
  }
  if (context.framework === "react-router") {
    await updateReactRouterProject(context);
    return;
  }
  if (context.framework === "nuxt") {
    await updateNuxtProject(context);
    return;
  }

  const tsConfigPath = resolve(context.cwd, "tsconfig.json");
  const tsConfigNodePath = resolve(context.cwd, "tsconfig.node.json");

  const readJsonc = async (path: string) => {
    const content = await fs.readFile(path, "utf-8");
    // Regular expression to strip comments and trailing commas
    const jsonc = content
      .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")
      .replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(jsonc);
  };

  if (await fs.pathExists(tsConfigPath)) {
    try {
      const tsConfig = await readJsonc(tsConfigPath);

      if (context.framework === "vite") {
        if (tsConfig.include) {
          tsConfig.include = tsConfig.include.filter(
            (p: string) => p !== "alchemy.run.ts",
          );
        }
        if (tsConfig.compilerOptions && tsConfig.compilerOptions.types) {
          tsConfig.compilerOptions.types =
            tsConfig.compilerOptions.types.filter(
              (t: string) => t !== "./types/env.d.ts",
            );
        }
      }

      await fs.writeJson(tsConfigPath, tsConfig, { spaces: 2 });
    } catch (error) {
      console.warn(`Failed to update ${tsConfigPath}:`, error);
    }
  }

  if (context.framework === "vite") {
    try {
      let tsConfigNode: any = {};
      if (await fs.pathExists(tsConfigNodePath)) {
        tsConfigNode = await readJsonc(tsConfigNodePath);
      }

      if (!tsConfigNode.include) {
        tsConfigNode.include = [];
      }
      if (!tsConfigNode.include.includes("alchemy.run.ts")) {
        tsConfigNode.include.push("alchemy.run.ts");
      }

      await fs.writeJson(tsConfigNodePath, tsConfigNode, { spaces: 2 });
    } catch (error) {
      console.warn(`Failed to update ${tsConfigNodePath}:`, error);
    }
  }
}

async function updateNuxtProject(context: InitContext) {
  const nuxtConfigPath = resolve(context.cwd, "nuxt.config.ts");
  if (await fs.pathExists(nuxtConfigPath)) {
    try {
      const project = new Project({
        manipulationSettings: {
          indentationText: IndentationText.TwoSpaces,
          quoteKind: QuoteKind.Double,
        },
      });
      project.addSourceFileAtPath(nuxtConfigPath);
      const sourceFile = project.getSourceFileOrThrow(nuxtConfigPath);

      const exportAssignment = sourceFile.getExportAssignment(
        (d) => !d.isExportEquals(),
      );
      if (exportAssignment) {
        const defineConfigCall = exportAssignment.getExpression();
        if (
          Node.isCallExpression(defineConfigCall) &&
          defineConfigCall.getExpression().getText() === "defineNuxtConfig"
        ) {
          let configObject = defineConfigCall.getArguments()[0];

          if (!configObject) {
            configObject = defineConfigCall.addArgument("{}");
          }

          if (Node.isObjectLiteralExpression(configObject)) {
            // Add nitro property
            if (!configObject.getProperty("nitro")) {
              configObject.addPropertyAssignment({
                name: "nitro",
                initializer: `{
    preset: "cloudflare_module",
    cloudflare: {
      deployConfig: true,
      nodeCompat: true
    }
  }`,
              });
            }

            // Add modules property
            const modulesProperty = configObject.getProperty("modules");
            if (modulesProperty && Node.isPropertyAssignment(modulesProperty)) {
              const initializer = modulesProperty.getInitializer();
              if (Node.isArrayLiteralExpression(initializer)) {
                const hasModule = initializer
                  .getElements()
                  .some(
                    (el) =>
                      el.getText() === '"nitro-cloudflare-dev"' ||
                      el.getText() === "'nitro-cloudflare-dev'",
                  );
                if (!hasModule) {
                  initializer.addElement('"nitro-cloudflare-dev"');
                }
              }
            } else if (!modulesProperty) {
              configObject.addPropertyAssignment({
                name: "modules",
                initializer: '["nitro-cloudflare-dev"]',
              });
            }
          }
        }
      }

      await project.save();
    } catch (error) {
      console.warn(`Failed to update ${nuxtConfigPath}:`, error);
    }
  }

  const tsConfigPath = resolve(context.cwd, "tsconfig.json");
  if (await fs.pathExists(tsConfigPath)) {
    try {
      const readJsonc = async (path: string) => {
        const content = await fs.readFile(path, "utf-8");
        // Regular expression to strip comments and trailing commas
        const jsonc = content
          .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")
          .replace(/,(\s*[}\]])/g, "$1");
        return JSON.parse(jsonc);
      };
      const tsConfig = await readJsonc(tsConfigPath);

      if (!tsConfig.include) {
        tsConfig.include = [];
      }
      if (!tsConfig.include.includes("alchemy.run.ts")) {
        tsConfig.include.push("alchemy.run.ts");
      }

      await fs.writeJson(tsConfigPath, tsConfig, { spaces: 2 });
    } catch (error) {
      console.warn(`Failed to update ${tsConfigPath}:`, error);
    }
  }
}

async function updateAstroProject(context: InitContext) {
  const tsConfigPath = resolve(context.cwd, "tsconfig.json");
  if (await fs.pathExists(tsConfigPath)) {
    try {
      const readJsonc = async (path: string) => {
        const content = await fs.readFile(path, "utf-8");
        const jsonc = content
          .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")
          .replace(/,(\s*[}\]])/g, "$1");
        return JSON.parse(jsonc);
      };
      const tsConfig = await readJsonc(tsConfigPath);

      if (!tsConfig.include) tsConfig.include = [];
      if (!tsConfig.include.includes("alchemy.run.ts")) {
        tsConfig.include.push("alchemy.run.ts");
      }
      if (!tsConfig.include.includes("types/**/*.ts")) {
        tsConfig.include.push("types/**/*.ts");
      }

      if (!tsConfig.compilerOptions) tsConfig.compilerOptions = {};
      if (!tsConfig.compilerOptions.types) tsConfig.compilerOptions.types = [];
      if (
        !tsConfig.compilerOptions.types.includes("@cloudflare/workers-types")
      ) {
        tsConfig.compilerOptions.types.push("@cloudflare/workers-types");
      }
      if (!tsConfig.compilerOptions.types.includes("./types/env.d.ts")) {
        tsConfig.compilerOptions.types.push("./types/env.d.ts");
      }

      await fs.writeJson(tsConfigPath, tsConfig, { spaces: 2 });
    } catch (error) {
      console.warn(`Failed to update ${tsConfigPath}:`, error);
    }
  }

  const astroConfigPath = resolve(context.cwd, "astro.config.mjs");
  if (await fs.pathExists(astroConfigPath)) {
    try {
      const project = new Project({
        manipulationSettings: {
          indentationText: IndentationText.TwoSpaces,
          quoteKind: QuoteKind.Double,
        },
      });
      project.addSourceFileAtPath(astroConfigPath);
      const sourceFile = project.getSourceFileOrThrow(astroConfigPath);

      sourceFile.addImportDeclaration({
        moduleSpecifier: "@astrojs/cloudflare",
        defaultImport: "cloudflare",
      });

      const exportAssignment = sourceFile.getExportAssignment(
        (d) => !d.isExportEquals(),
      );
      if (exportAssignment) {
        const defineConfigCall = exportAssignment.getExpression();
        if (
          Node.isCallExpression(defineConfigCall) &&
          defineConfigCall.getExpression().getText() === "defineConfig"
        ) {
          let configObject = defineConfigCall.getArguments()[0];

          if (!configObject) {
            configObject = defineConfigCall.addArgument("{}");
          }

          if (Node.isObjectLiteralExpression(configObject)) {
            if (!configObject.getProperty("output")) {
              configObject.addPropertyAssignment({
                name: "output",
                initializer: "'server'",
              });
            }
            if (!configObject.getProperty("adapter")) {
              configObject.addPropertyAssignment({
                name: "adapter",
                initializer: "cloudflare()",
              });
            }
          }
        }
      }

      await project.save();
    } catch (error) {
      console.warn(`Failed to update ${astroConfigPath}:`, error);
    }
  }
}

async function updateReactRouterProject(context: InitContext) {
  const tsConfigNodePath = resolve(context.cwd, "tsconfig.json");
  if (await fs.pathExists(tsConfigNodePath)) {
    try {
      const readJsonc = async (path: string) => {
        const content = await fs.readFile(path, "utf-8");
        const jsonc = content
          .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")
          .replace(/,(\s*[}\]])/g, "$1");
        return JSON.parse(jsonc);
      };
      const tsConfig = await readJsonc(tsConfigNodePath);

      if (!tsConfig.include) tsConfig.include = [];
      if (!tsConfig.include.includes("alchemy.run.ts")) {
        tsConfig.include.push("alchemy.run.ts");
      }
      if (!tsConfig.include.includes("types/**/*.ts")) {
        tsConfig.include.push("types/**/*.ts");
      }

      if (!tsConfig.compilerOptions) tsConfig.compilerOptions = {};
      if (!tsConfig.compilerOptions.types) tsConfig.compilerOptions.types = [];
      if (
        !tsConfig.compilerOptions.types.includes("@cloudflare/workers-types")
      ) {
        tsConfig.compilerOptions.types.push("@cloudflare/workers-types");
      }
      if (!tsConfig.compilerOptions.types.includes("./types/env.d.ts")) {
        tsConfig.compilerOptions.types.push("./types/env.d.ts");
      }

      await fs.writeJson(tsConfigNodePath, tsConfig, { spaces: 2 });
    } catch (error) {
      console.warn(`Failed to update ${tsConfigNodePath}:`, error);
    }
  }
}

function displaySuccessMessage(context: InitContext): void {
  const fileExtension = context.useTypeScript ? "ts" : "js";
  const runFile = `alchemy.run.${fileExtension}`;

  note(`${pc.cyan("📁 Files created:")}
   ${runFile} - Your infrastructure configuration

${pc.cyan("🚀 Next steps:")}
   Edit ${runFile} to configure your infrastructure
   Run ${pc.yellow("npm run deploy")} to deploy
   Run ${pc.yellow("npm run destroy")} to clean up

${pc.cyan("📚 Learn more:")}
   https://alchemy.run`);

  outro(pc.green("Alchemy initialized successfully!"));
}
