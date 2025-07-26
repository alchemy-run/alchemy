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
import { parse as parseJsonc } from "jsonc-parse";
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
      await updateProjectConfiguration(context);

      displaySuccessMessage(context);
    } catch (_error) {
      console.error("Failed to initialize Alchemy:", _error);
      process.exit(1);
    }
  });

function sanitizeProjectName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[@/]/g, "")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 63)
    .replace(/-$/, "");
}

async function readJsonc(filePath: string): Promise<any> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return parseJsonc(content);
  } catch (error) {
    throw new Error(`Failed to read or parse ${filePath}: ${error}`);
  }
}

async function writeJsonWithSpaces(filePath: string, data: any): Promise<void> {
  await fs.writeJson(filePath, data, { spaces: 2 });
}

async function safelyUpdateJson(
  filePath: string,
  updater: (data: any) => void,
  fallbackData: any = {},
): Promise<void> {
  try {
    let data = fallbackData;
    if (await fs.pathExists(filePath)) {
      data = await readJsonc(filePath);
    }
    updater(data);
    await writeJsonWithSpaces(filePath, data);
  } catch (error) {
    console.warn(`Failed to update ${filePath}:`, error);
  }
}

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
      const packageJson = await readJsonc(packageJsonPath);
      if (packageJson?.name) {
        projectName = sanitizeProjectName(packageJson.name);
      }
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

const FRAMEWORK_DETECTION_MAP: Record<string, TemplateType> = {
  rwsdk: "rwsdk",
  astro: "astro",
  nuxt: "nuxt",
  "react-router": "react-router",
  "@sveltejs/kit": "sveltekit",
  "@tanstack/react-start": "tanstack-start",
  vite: "vite",
};

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
    ] as const,
    initialValue: detectedFramework,
  });

  if (isCancel(frameworkResult)) {
    cancel(pc.red("Operation cancelled."));
    process.exit(0);
  }

  return frameworkResult as TemplateType;
}

async function detectFrameworkFromPackageJson(
  cwd: string,
): Promise<TemplateType> {
  const packageJsonPath = resolve(cwd, "package.json");

  try {
    const packageJson = await readJsonc(packageJsonPath);
    const allDeps = {
      ...packageJson?.dependencies,
      ...packageJson?.devDependencies,
      ...packageJson?.peerDependencies,
    };

    for (const [dep, framework] of Object.entries(FRAMEWORK_DETECTION_MAP)) {
      if (dep in allDeps) return framework;
    }

    return "typescript";
  } catch (_error) {
    return "typescript";
  }
}

async function checkExistingAlchemyFiles(context: InitContext): Promise<void> {
  const alchemyFiles = ["alchemy.run.ts", "alchemy.run.js"];
  const existingFile = alchemyFiles.find((file) =>
    fs.pathExistsSync(resolve(context.cwd, file)),
  );

  if (existingFile) {
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

const ALCHEMY_RUN_TEMPLATES: Record<
  TemplateType,
  (context: InitContext) => string
> = {
  typescript: (context) => `/// <reference types="@types/node" />

import alchemy from "alchemy";
import { Worker } from "alchemy/cloudflare";

const app = await alchemy("${context.projectName}");

export const worker = await Worker("worker", {
  name: "${context.projectName}",
  entrypoint: "src/worker.ts",
});

console.log(worker.url);
await app.finalize();
`,

  vite: (context) => `import alchemy from "alchemy";
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

  astro: (context) => `/// <reference types="@types/node" />

import alchemy from "alchemy";
import { Astro } from "alchemy/cloudflare";

const app = await alchemy("${context.projectName}");

export const worker = await Astro("website", {
  command: "${context.packageManager} run build",
});

console.log({
  url: worker.url,
});

await app.finalize();
`,

  "react-router": (context) => `/// <reference types="@types/node" />

import alchemy from "alchemy";
import { ReactRouter } from "alchemy/cloudflare";

const app = await alchemy("${context.projectName}");

export const worker = await ReactRouter("website", {
  main: "./workers/app.ts",
  command: "${context.packageManager} run build",
});

console.log({
  url: worker.url,
});

await app.finalize();
`,

  sveltekit: (context) => `/// <reference types="@types/node" />

import alchemy from "alchemy";
import { SvelteKit } from "alchemy/cloudflare";

const app = await alchemy("${context.projectName}");

export const worker = await SvelteKit("website", {
  command: "${context.packageManager} run build",
});

console.log({
  url: worker.url,
});

await app.finalize();
`,

  "tanstack-start": () => "",

  rwsdk: (context) => `/// <reference types="@types/node" />

import alchemy from "alchemy";
import { D1Database, DurableObjectNamespace, Redwood } from "alchemy/cloudflare";

const app = await alchemy("${context.projectName}");

const database = await D1Database("database", {
  name: "${context.projectName}-db",
  migrationsDir: "migrations",
});

export const worker = await Redwood("website", {
  name: "${context.projectName}-website",
  command: "${context.packageManager} run build",
  bindings: {
    AUTH_SECRET_KEY: alchemy.secret(process.env.AUTH_SECRET_KEY),
    DB: database,
    SESSION_DURABLE_OBJECT: DurableObjectNamespace("session", {
      className: "SessionDurableObject",
    }),
  },
});

console.log({
  url: worker.url,
});

await app.finalize();
`,

  nuxt: (context) => `/// <reference types="@types/node" />

import alchemy from "alchemy";
import { Nuxt } from "alchemy/cloudflare";

const app = await alchemy("${context.projectName}");

export const worker = await Nuxt("website", {
  command: "${context.packageManager} run build",
});

console.log({
  url: worker.url,
});

await app.finalize();
`,
};

async function createAlchemyRunFile(context: InitContext): Promise<void> {
  try {
    const content = ALCHEMY_RUN_TEMPLATES[context.framework](context);
    const outputFileName = context.useTypeScript
      ? "alchemy.run.ts"
      : "alchemy.run.js";
    const outputPath = resolve(context.cwd, outputFileName);
    await fs.writeFile(outputPath, content, "utf-8");
  } catch (error) {
    throwWithContext(error, "Failed to create alchemy.run file");
  }
}

const FRAMEWORK_DEPENDENCIES: Record<TemplateType, DependencyVersionMap[]> = {
  nuxt: ["alchemy", "nitro-cloudflare-dev"],
  sveltekit: ["alchemy", "@sveltejs/adapter-cloudflare"],
  typescript: ["alchemy"],
  vite: ["alchemy"],
  astro: ["alchemy"],
  "react-router": ["alchemy"],
  "tanstack-start": ["alchemy"],
  rwsdk: ["alchemy"],
};

const DEFAULT_SCRIPTS = {
  deploy: "alchemy deploy",
  destroy: "alchemy destroy",
  "alchemy:dev": "alchemy dev",
};

async function updatePackageJson(context: InitContext): Promise<void> {
  try {
    const devDependencies = FRAMEWORK_DEPENDENCIES[context.framework];
    await addPackageDependencies({
      devDependencies,
      projectDir: context.cwd,
    });

    const packageJsonPath = resolve(context.cwd, "package.json");
    await safelyUpdateJson(packageJsonPath, (packageJson) => {
      if (!packageJson.scripts) {
        packageJson.scripts = {};
      }

      for (const [script, command] of Object.entries(DEFAULT_SCRIPTS)) {
        if (!packageJson.scripts[script]) {
          packageJson.scripts[script] = command;
        }
      }
    });
  } catch (error) {
    throwWithContext(error, "Failed to update package.json");
  }
}

interface TsConfigUpdate {
  include?: string[];
  exclude?: string[];
  compilerOptions?: {
    types?: string[];
  };
}

async function updateTsConfig(
  configPath: string,
  updates: TsConfigUpdate,
): Promise<void> {
  await safelyUpdateJson(configPath, (tsConfig) => {
    if (updates.include) {
      if (!tsConfig.include) tsConfig.include = [];
      updates.include.forEach((item) => {
        if (!tsConfig.include.includes(item)) {
          tsConfig.include.push(item);
        }
      });
    }

    if (updates.exclude) {
      if (tsConfig.include) {
        tsConfig.include = tsConfig.include.filter(
          (p: string) => !updates.exclude!.includes(p),
        );
      }
    }

    if (updates.compilerOptions?.types) {
      if (!tsConfig.compilerOptions) tsConfig.compilerOptions = {};
      if (!tsConfig.compilerOptions.types) tsConfig.compilerOptions.types = [];

      updates.compilerOptions.types.forEach((type) => {
        if (!tsConfig.compilerOptions.types.includes(type)) {
          tsConfig.compilerOptions.types.push(type);
        }
      });
    }
  });
}

async function updateProjectConfiguration(context: InitContext): Promise<void> {
  const updaters: Record<TemplateType, () => Promise<void>> = {
    typescript: () => updateTypescriptProject(context),
    vite: () => updateViteProject(context),
    astro: () => updateAstroProject(context),
    "react-router": () => updateReactRouterProject(context),
    sveltekit: () => updateSvelteKitProject(context),
    "tanstack-start": () => Promise.resolve(),
    rwsdk: () => updateRwsdkProject(context),
    nuxt: () => updateNuxtProject(context),
  };

  await updaters[context.framework]();
}

async function updateTypescriptProject(context: InitContext): Promise<void> {
  const tsConfigPath = resolve(context.cwd, "tsconfig.json");
  if (await fs.pathExists(tsConfigPath)) {
    await updateTsConfig(tsConfigPath, {
      include: ["alchemy.run.ts"],
    });
  }
}

async function updateViteProject(context: InitContext): Promise<void> {
  // const tsConfigPath = resolve(context.cwd, "tsconfig.json");
  // const tsConfigNodePath = resolve(context.cwd, "tsconfig.node.json");
  // if (await fs.pathExists(tsConfigPath)) {
  //   await updateTsConfig(tsConfigPath, {
  //     exclude: ["alchemy.run.ts", "./types/env.d.ts"],
  //   });
  // }
  // if ((await fs.pathExists(tsConfigNodePath)) || context.framework === "vite") {
  //   await updateTsConfig(tsConfigNodePath, {
  //     include: ["alchemy.run.ts"],
  //   });
  // }
}

async function updateSvelteKitProject(context: InitContext): Promise<void> {
  await updateSvelteConfig(context);

  // const tsConfigPath = resolve(context.cwd, "tsconfig.json");
  // await updateTsConfig(tsConfigPath, {
  //   include: ["alchemy.run.ts"],
  // });
}

async function updateRwsdkProject(context: InitContext): Promise<void> {
  await updateEnvFile(context);

  // const tsConfigPath = resolve(context.cwd, "tsconfig.json");
  // await updateTsConfig(tsConfigPath, {
  //   include: ["alchemy.run.ts"],
  // });
}

async function updateNuxtProject(context: InitContext): Promise<void> {
  await updateNuxtConfig(context);

  // const tsConfigPath = resolve(context.cwd, "tsconfig.json");
  // await updateTsConfig(tsConfigPath, {
  //   include: ["alchemy.run.ts"],
  // });
}

async function updateAstroProject(context: InitContext): Promise<void> {
  await updateAstroConfig(context);

  // const tsConfigPath = resolve(context.cwd, "tsconfig.json");
  // await updateTsConfig(tsConfigPath, {
  //   include: ["alchemy.run.ts", "types/**/*.ts"],
  //   compilerOptions: {
  //     types: ["@cloudflare/workers-types", "./types/env.d.ts"],
  //   },
  // });
}

async function updateReactRouterProject(context: InitContext): Promise<void> {
  const tsConfigPath = resolve(context.cwd, "tsconfig.json");
  // await updateTsConfig(tsConfigPath, {
  //   include: ["alchemy.run.ts", "types/**/*.ts"],
  //   compilerOptions: {
  //     types: ["@cloudflare/workers-types", "./types/env.d.ts"],
  //   },
  // });
}

async function updateSvelteConfig(context: InitContext): Promise<void> {
  const svelteConfigPath = resolve(context.cwd, "svelte.config.js");
  if (!(await fs.pathExists(svelteConfigPath))) return;

  try {
    const project = new Project({
      manipulationSettings: {
        indentationText: IndentationText.TwoSpaces,
        quoteKind: QuoteKind.Single,
      },
    });

    project.addSourceFileAtPath(svelteConfigPath);
    const sourceFile = project.getSourceFileOrThrow(svelteConfigPath);

    const importDeclarations = sourceFile.getImportDeclarations();
    const adapterImport = importDeclarations.find((imp) =>
      imp.getModuleSpecifierValue().includes("@sveltejs/adapter"),
    );

    if (adapterImport) {
      adapterImport.setModuleSpecifier("@sveltejs/adapter-cloudflare");
    } else {
      sourceFile.insertImportDeclaration(0, {
        moduleSpecifier: "@sveltejs/adapter-cloudflare",
        defaultImport: "adapter",
      });
    }

    await project.save();
  } catch (error) {
    console.warn("Failed to update svelte.config.js:", error);
  }
}

async function updateEnvFile(context: InitContext): Promise<void> {
  const envPath = resolve(context.cwd, ".env");
  await fs.ensureFile(envPath);

  const envVars = [
    "AUTH_SECRET_KEY=your-development-secret-key",
    "ALCHEMY_PASSWORD=change-me",
  ];

  let envContent = "";
  if (await fs.pathExists(envPath)) {
    try {
      envContent = await fs.readFile(envPath, "utf-8");
    } catch (error) {
      console.warn("Failed to read .env:", error);
    }
  }

  let needsUpdate = false;
  for (const envVar of envVars) {
    const [key] = envVar.split("=");
    if (!envContent.includes(`${key}=`)) {
      if (envContent && !envContent.endsWith("\n")) {
        envContent += "\n";
      }
      envContent += `${envVar}\n`;
      needsUpdate = true;
    }
  }

  if (needsUpdate) {
    try {
      await fs.writeFile(envPath, envContent, "utf-8");
    } catch (error) {
      console.warn("Failed to update .env:", error);
    }
  }
}

async function updateNuxtConfig(context: InitContext): Promise<void> {
  const nuxtConfigPath = resolve(context.cwd, "nuxt.config.ts");
  if (!(await fs.pathExists(nuxtConfigPath))) return;

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
    if (!exportAssignment) return;

    const defineConfigCall = exportAssignment.getExpression();
    if (
      !Node.isCallExpression(defineConfigCall) ||
      defineConfigCall.getExpression().getText() !== "defineNuxtConfig"
    )
      return;

    let configObject = defineConfigCall.getArguments()[0];
    if (!configObject) {
      configObject = defineConfigCall.addArgument("{}");
    }

    if (Node.isObjectLiteralExpression(configObject)) {
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

    await project.save();
  } catch (error) {
    console.warn("Failed to update nuxt.config.ts:", error);
  }
}

async function updateAstroConfig(context: InitContext): Promise<void> {
  const astroConfigPath = resolve(context.cwd, "astro.config.mjs");
  if (!(await fs.pathExists(astroConfigPath))) return;

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
    if (!exportAssignment) return;

    const defineConfigCall = exportAssignment.getExpression();
    if (
      !Node.isCallExpression(defineConfigCall) ||
      defineConfigCall.getExpression().getText() !== "defineConfig"
    )
      return;

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

    await project.save();
  } catch (error) {
    console.warn("Failed to update astro.config.mjs:", error);
  }
}

function displaySuccessMessage(context: InitContext): void {
  const fileExtension = context.useTypeScript ? "ts" : "js";
  const runFile = `alchemy.run.${fileExtension}`;

  note(`${pc.cyan("📁 Files created:")}
   ${runFile} - Your infrastructure configuration

${pc.cyan("🚀 Next steps:")}
   Edit ${runFile} to configure your infrastructure
   Run ${pc.yellow(`${context.packageManager} run deploy`)} to deploy
   Run ${pc.yellow(`${context.packageManager} run destroy`)} to clean up

${pc.cyan("📚 Learn more:")}
   https://alchemy.run`);

  outro(pc.green("Alchemy initialized successfully!"));
}
