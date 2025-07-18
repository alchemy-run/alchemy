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
import { PKG_ROOT } from "../constants.ts";
import { throwWithContext } from "../errors.ts";
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
      await copyAlchemyRunFile(context);
      await updatePackageJson(context);

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

  const useTypeScript = await detectTypeScript(cwd);
  const framework =
    options.framework ||
    (await detectFramework(cwd, hasPackageJson, options.yes));

  return {
    cwd,
    framework,
    useTypeScript,
    projectName,
    hasPackageJson,
  };
}

async function detectTypeScript(cwd: string): Promise<boolean> {
  const tsconfigPath = resolve(cwd, "tsconfig.json");
  if (await fs.pathExists(tsconfigPath)) {
    return true;
  }

  const packageJsonPath = resolve(cwd, "package.json");
  if (await fs.pathExists(packageJsonPath)) {
    try {
      const packageJson = await fs.readJson(packageJsonPath);
      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
        ...packageJson.peerDependencies,
      };

      return "typescript" in allDeps || "@types/node" in allDeps;
    } catch (_error) {
      // If we can't read package.json, assume TypeScript
      return true;
    }
  }

  return false;
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
      { label: "React Vite", value: "vite" },
      { label: "Astro SSR", value: "astro" },
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

    if ("@redwoodjs/core" in allDeps || "@redwoodjs/web" in allDeps) {
      return "rwsdk";
    }

    if ("astro" in allDeps) {
      return "astro";
    }

    if ("nuxt" in allDeps) {
      return "nuxt";
    }

    if ("react-router-dom" in allDeps || "react-router" in allDeps) {
      return "react-router";
    }

    if ("@sveltejs/kit" in allDeps) {
      return "sveltekit";
    }

    if ("@tanstack/react-start" in allDeps) {
      return "tanstack-start";
    }

    if ("vite" in allDeps) {
      return "vite";
    }

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

    if (isCancel(overwriteResult)) {
      cancel(pc.red("Operation cancelled."));
      process.exit(0);
    }

    if (!overwriteResult) {
      outro(pc.yellow("Initialization cancelled."));
      process.exit(0);
    }
  }
}

async function copyAlchemyRunFile(context: InitContext) {
  try {
    const templatePath = resolve(
      PKG_ROOT,
      "templates",
      context.framework,
      "alchemy.run.ts",
    );

    if (!(await fs.pathExists(templatePath))) {
      throw new Error(`Template not found for framework: ${context.framework}`);
    }

    let content = await fs.readFile(templatePath, "utf-8");

    content = content.replace(/my-alchemy-app/g, context.projectName);

    const outputFileName = context.useTypeScript
      ? "alchemy.run.ts"
      : "alchemy.run.js";
    const outputPath = resolve(context.cwd, outputFileName);

    if (!context.useTypeScript) {
      content = content.replace(
        /\/\/\/ <reference types="@types\/node" \/>\n\n/,
        "",
      );
    }

    await fs.writeFile(outputPath, content, "utf-8");
  } catch (error) {
    throwWithContext(error, "Failed to create alchemy.run file");
  }
}

async function updatePackageJson(context: InitContext) {
  try {
    await addPackageDependencies({
      devDependencies: ["alchemy"],
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
