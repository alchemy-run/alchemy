#!/usr/bin/env node

import { confirm, input, select } from "@inquirer/prompts";
import { applyEdits, modify } from "jsonc-parser";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";

// Package manager detection
type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

// CLI options interface
interface CliOptions {
  name?: string;
  template?: string;
  yes?: boolean;
  overwrite?: boolean;
  help?: boolean;
  version?: boolean;
}

// Define templates
const templates: Template[] = [
  {
    name: "typescript",
    description: "Basic TypeScript Worker project",
    init: initTypescriptProject,
  },
  {
    name: "vite",
    description: "React Vite.js application",
    init: initViteProject,
  },
  {
    name: "astro",
    description: "Astro application with SSR",
    init: initAstroProject,
  },
  {
    name: "react-router",
    description: "React Router application",
    init: initReactRouterProject,
  },
  {
    name: "sveltekit",
    description: "SvelteKit application",
    init: initSvelteKitProject,
  },
  {
    name: "tanstack-start",
    description: "TanStack Start application (coming soon)",
    init: async () => {
      console.log("❌ TanStack Start template not yet implemented");
      process.exit(1);
    },
  },
  {
    name: "redwood",
    description: "RedwoodJS application (coming soon)",
    init: async () => {
      console.log("❌ Redwood template not yet implemented");
      process.exit(1);
    },
  },
  {
    name: "nuxt",
    description: "Nuxt.js application (coming soon)",
    init: async () => {
      console.log("❌ Nuxt template not yet implemented");
      process.exit(1);
    },
  },
];

const args = process.argv.slice(2);
const options: CliOptions = {};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg === "--help" || arg === "-h") {
    options.help = true;
  } else if (arg === "--version" || arg === "-v") {
    options.version = true;
  } else if (arg === "--yes" || arg === "-y") {
    options.yes = true;
  } else if (arg === "--overwrite") {
    options.overwrite = true;
  } else if (arg.startsWith("--name=")) {
    options.name = arg.split("=")[1];
  } else if (arg.startsWith("--template=")) {
    options.template = arg.split("=")[1];
  }
}

// Handle help and version flags
if (options.help) {
  console.log(`
Usage: alchemy [options]

Options:
-h, --help          Show help
-v, --version       Show version
--name=<name>       Project name (non-interactive)
--template=<name>   Template name (non-interactive)
-y, --yes           Skip confirmations (non-interactive)
--overwrite         Overwrite existing directory

Templates:
${templates.map((t) => `  ${t.name.padEnd(15)} ${t.description}`).join("\n")}
`);
  process.exit(0);
}

if (options.version) {
  console.log("0.28.0");
  process.exit(0);
}

console.log("🧪 Welcome to Alchemy!");
console.log("Creating a new Alchemy project...\n");

const pm = detectPackageManager();
console.log(`Detected package manager: ${pm}\n`);

// Get project name (interactive or from CLI args)
let projectName: string;
if (options.name) {
  projectName = options.name;
  console.log(`Using project name: ${projectName}`);
} else {
  projectName = await input({
    message: "What is your project name?",
    default: "my-alchemy-app",
    validate: (input) => {
      if (!input.trim()) return "Project name is required";
      if (!/^[a-z0-9-_]+$/i.test(input))
        return "Project name can only contain letters, numbers, hyphens, and underscores";
      return true;
    },
  });
}

// Validate project name even if provided via CLI
if (!projectName.trim()) {
  console.error("Error: Project name is required");
  process.exit(1);
}
if (!/^[a-z0-9-_]+$/i.test(projectName)) {
  console.error(
    "Error: Project name can only contain letters, numbers, hyphens, and underscores",
  );
  process.exit(1);
}

// Get template (interactive or from CLI args)
let template: string;
if (options.template) {
  template = options.template;
  console.log(`Using template: ${template}`);
  // Validate template exists
  if (!templates.find((t) => t.name === template)) {
    console.error(
      `Error: Template '${template}' not found. Available templates: ${templates.map((t) => t.name).join(", ")}`,
    );
    process.exit(1);
  }
} else {
  template = await select({
    message: "Which template would you like to use?",
    choices: templates.map((t) => ({
      name: t.description,
      value: t.name,
    })),
  });
}

const selectedTemplate = templates.find((t) => t.name === template)!;

// Check if directory exists
const projectPath = resolve(process.cwd(), projectName);
if (existsSync(projectPath)) {
  let overwrite: boolean;
  if (options.overwrite || options.yes) {
    overwrite = true;
    console.log(
      `Directory ${projectName} already exists. Overwriting due to CLI flag.`,
    );
  } else {
    overwrite = await confirm({
      message: `Directory ${projectName} already exists. Overwrite?`,
      default: false,
    });
  }

  if (!overwrite) {
    console.log("Cancelled.");
    process.exit(0);
  }
}

// Create project directory
await fs.mkdir(projectPath, { recursive: true });

console.log(`\n🔨 Creating ${template} project in ${projectPath}...`);

// Initialize the template
await selectedTemplate.init(pm, projectName, projectPath);

// Create .gitignore if it doesn't exist
const gitignorePath = join(projectPath, ".gitignore");
if (!existsSync(gitignorePath)) {
  await fs.writeFile(
    gitignorePath,
    `node_modules/
.env
.env.local
dist/
lib/
.wrangler/
wrangler.jsonc
*.tsbuildinfo
`,
  );
}

console.log(`\n✅ Project ${projectName} created successfully!`);
console.log("\n📁 Navigate to your project:");
console.log(`   cd ${projectName}`);
console.log("\n🚀 Deploy your project:");
console.log(`   ${pm} run deploy`);
console.log("\n🧹 Destroy your project:");
console.log(`   ${pm} run destroy`);
console.log("\n📚 Learn more: https://alchemy.run");

function detectPackageManager(): PackageManager {
  // Check npm_execpath for bun
  if (process.env.npm_execpath?.includes("bun")) {
    return "bun";
  }

  // Check npm_config_user_agent
  const userAgent = process.env.npm_config_user_agent;
  if (userAgent) {
    if (userAgent.startsWith("bun")) return "bun";
    if (userAgent.startsWith("pnpm")) return "pnpm";
    if (userAgent.startsWith("yarn")) return "yarn";
    if (userAgent.startsWith("npm")) return "npm";
  }

  // Default fallback
  return "npm";
}

function getPackageManagerCommands(pm: PackageManager) {
  const commands = {
    bun: {
      init: "bun init -y",
      install: "bun install",
      add: "bun add",
      addDev: "bun add -D",
      run: "bun",
      create: "bun create",
      x: "bunx",
    },
    npm: {
      init: "npm init -y",
      install: "npm install",
      add: "npm install",
      addDev: "npm install --save-dev",
      run: "npx",
      create: "npm create",
      x: "npx",
    },
    pnpm: {
      init: "pnpm init",
      install: "pnpm install",
      add: "pnpm add",
      addDev: "pnpm add -D",
      run: "pnpm",
      create: "pnpm create",
      x: "pnpm dlx",
    },
    yarn: {
      init: "yarn init -y",
      install: "yarn install",
      add: "yarn add",
      addDev: "yarn add -D",
      run: "yarn",
      create: "yarn create",
      x: "yarn dlx",
    },
  };

  return commands[pm];
}

// Template definitions
interface Template {
  name: string;
  description: string;
  init: (
    pm: PackageManager,
    projectName: string,
    projectPath: string,
  ) => Promise<void>;
}

function createAlchemyRunTs(
  template: string,
  projectName: string,
  options?: {
    entrypoint?: string;
  },
): string {
  if (template === "typescript") {
    return `/// <reference types="@types/node" />

import alchemy from "alchemy";
import { Worker } from "alchemy/cloudflare";

const app = await alchemy("${projectName}");

export const worker = await Worker("worker", {
  entrypoint: "${options?.entrypoint || "./src/worker.ts"}",
});

console.log(worker.url);

await app.finalize();
`;
  }

  // For all website variants, use unified template
  return createWebsiteTemplate(template, projectName, options);
}

function createWebsiteTemplate(
  template: string,
  projectName: string,
  options?: {
    entrypoint?: string;
  },
): string {
  // Map template names to their corresponding resource names
  const resourceMap: Record<string, string> = {
    vite: "Vite",
    astro: "Astro",
    "react-router": "ReactRouter",
    sveltekit: "SvelteKit",
    "tanstack-start": "TanStackStart",
    redwood: "Redwood",
    nuxt: "Nuxt",
  };

  const resourceName = resourceMap[template];
  if (!resourceName) {
    throw new Error(`Unknown template: ${template}`);
  }

  // Special configuration for Vite template
  const config =
    template === "vite"
      ? `{
  main: "${options?.entrypoint || "./src/index.ts"}",
  command: "${detectPackageManager()} run build",
}`
      : `{
  command: "${detectPackageManager()} run build",
}`;

  return `/// <reference types="@types/node" />

import alchemy from "alchemy";
import { ${resourceName} } from "alchemy/cloudflare";

const app = await alchemy("${projectName}");

export const worker = await ${resourceName}("website", ${config});

console.log({
  url: worker.url,
});

await app.finalize();
`;
}

function execCommand(command: string, cwd: string): void {
  console.log(`Running: ${command}`);
  try {
    execSync(command, { stdio: "inherit", cwd });
  } catch {
    console.error(`Failed to execute: ${command}`);
    process.exit(1);
  }
}

async function initTypescriptProject(
  pm: PackageManager,
  projectName: string,
  projectPath: string,
): Promise<void> {
  const commands = getPackageManagerCommands(pm);

  // Initialize project
  execCommand(commands.init, projectPath);

  await createEnvTs(projectPath);

  // Create basic project structure
  await fs.mkdir(join(projectPath, "src"), { recursive: true });

  // Create worker.ts
  await fs.writeFile(
    join(projectPath, "src", "worker.ts"),
    `import type { worker } from "../alchemy.run.ts";

export default {
  async fetch(request: Request, env: typeof worker.Env, ctx: ExecutionContext): Promise<Response> {
    return new Response("Hello World from ${projectName}!");
  },
};
`,
  );

  // Create tsconfig.json
  await fs.writeFile(
    join(projectPath, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
          rewriteRelativeImportExtensions: true,
          types: ["@cloudflare/workers-types", "@types/node"],
        },
        include: ["src/**/*", "types/**/*", "alchemy.run.ts"],
      },
      null,
      2,
    ),
  );

  // Install dependencies
  execCommand(
    `${commands.addDev} alchemy @cloudflare/workers-types @types/node typescript`,
    projectPath,
  );
}

async function rm(path: string): Promise<void> {
  if (existsSync(path)) {
    await fs.rm(path, { recursive: true });
  }
}

async function initViteProject(
  pm: PackageManager,
  projectName: string,
  projectPath: string,
): Promise<void> {
  execCommand(
    `${getPackageManagerCommands(pm).x} create-vite@6.5.0 vite --template react-ts`,
    process.cwd(),
  );
  const root = projectPath;
  await rm(join(root, "tsconfig.app.json"));
  await rm(join(root, "tsconfig.node.json"));

  await initWebsiteProject(pm, projectPath, {
    entrypoint: "worker/index.ts",
  });

  await fs.writeFile(
    join(root, "vite.config.ts"),
    `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import { cloudflare } from "@cloudflare/vite-plugin";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cloudflare()],
});
`,
  );
  await fs.writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "es2021",
          lib: ["es2021"],
          jsx: "react-jsx",
          module: "es2022",
          moduleResolution: "Bundler",
          resolveJsonModule: true,
          allowJs: true,
          checkJs: false,
          noEmit: true,
          isolatedModules: true,
          allowSyntheticDefaultImports: true,
          forceConsistentCasingInFileNames: true,
          allowImportingTsExtensions: true,
          rewriteRelativeImportExtensions: true,
          strict: true,
          skipLibCheck: true,
          types: ["@cloudflare/workers-types"],
        },
        exclude: ["test"],
        include: ["types/**/*.ts", "src/**/*.ts"],
      },
      null,
      2,
    ),
  );
  await fs.mkdir(join(root, "worker"), { recursive: true });
  await fs.writeFile(
    join(root, "worker", "index.ts"),
    `export default {
  fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return Response.json({
        name: "Cloudflare",
      });
    }
		return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
`,
  );
}

async function initAstroProject(
  pm: PackageManager,
  projectName: string,
  projectPath: string,
): Promise<void> {
  await initWebsiteProject(pm, projectPath);

  // Update astro.config.mjs
  await fs.writeFile(
    join(projectPath, "astro.config.ts"),
    `import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
});
`,
  );

  // Create API route example
  await fs.mkdir(join(projectPath, "src", "pages", "api"), { recursive: true });
  await fs.writeFile(
    join(projectPath, "src", "pages", "api", "hello.ts"),
    `import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ request }) => {
  // Access Cloudflare runtime context
  const runtime = request.cf;
  
  return new Response(JSON.stringify({
    message: "Hello from Astro API on Cloudflare!",
    timestamp: new Date().toISOString(),
    colo: runtime?.colo || "unknown",
    country: runtime?.country || "unknown",
    city: runtime?.city || "unknown",
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  });
};
`,
  );
}

async function initReactRouterProject(
  pm: PackageManager,
  projectName: string,
  projectPath: string,
): Promise<void> {
  await initWebsiteProject(pm, projectPath);
}

async function initSvelteKitProject(
  pm: PackageManager,
  projectName: string,
  projectPath: string,
): Promise<void> {
  await initWebsiteProject(pm, projectPath);

  // Update svelte.config.js
  await fs.writeFile(
    join(projectPath, "svelte.config.js"),
    `import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
\tpreprocess: vitePreprocess(),
\tkit: {
\t\tadapter: adapter()
\t}
};

export default config;
`,
  );

  // Create vite.config.ts
  await fs.writeFile(
    join(projectPath, "vite.config.ts"),
    `import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
\tplugins: [sveltekit()],
});
`,
  );
}

/**
 * Unified initialization function for website projects that use create-cloudflare
 */
async function initWebsiteProject(
  pm: PackageManager,
  projectPath: string,
  options?: {
    entrypoint?: string;
  },
): Promise<void> {
  const commands = getPackageManagerCommands(pm);

  // // Create project using create-cloudflare
  // execCommand(
  //   `${commands.create} cloudflare@latest ${projectName} -- --framework=${framework} --platform=workers --no-deploy --lang=ts ${process.argv.slice(2).join(" ")}`,
  //   process.cwd(),
  // );

  await createEnvTs(projectPath);
  await cleanupWrangler(projectPath);
  await modifyTsConfig(projectPath);
  await modifyPackageJson(projectPath, pm);

  // Create alchemy.run.ts
  await fs.writeFile(
    join(projectPath, "alchemy.run.ts"),
    createAlchemyRunTs(template, projectName, options),
  );

  // Install alchemy dependencies (always include Workers types for Cloudflare Workers projects)
  const deps = "@cloudflare/workers-types alchemy";

  // Add tsx for non-bun package managers
  const alchemyDeps = pm === "bun" ? deps : `${deps} tsx`;

  execCommand(`${commands.addDev} ${alchemyDeps}`, projectPath);
}

async function createEnvTs(
  projectPath: string,
  identifier = "worker",
): Promise<void> {
  // Create env.ts for proper typing
  await fs.mkdir(join(projectPath, "types"), { recursive: true });
  await fs.writeFile(
    join(projectPath, "types", "env.ts"),
    `// This file infers types for the cloudflare:workers environment from your Alchemy Worker.
// @see https://alchemy.run/docs/concepts/bindings.html#type-safe-bindings

import type { ${identifier} } from "../alchemy.run.ts";

export type CloudflareEnv = typeof ${identifier}.Env;

declare global {
  type Env = CloudflareEnv;
}

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends CloudflareEnv {}
  }
}
`,
  );
}

async function cleanupWrangler(projectPath: string): Promise<void> {
  if (existsSync(join(projectPath, "worker-configuration.d.ts"))) {
    await fs.unlink(join(projectPath, "worker-configuration.d.ts"));
  }
  if (existsSync(join(projectPath, "wrangler.jsonc"))) {
    await fs.unlink(join(projectPath, "wrangler.jsonc"));
  }
}

/**
 * Modifies tsconfig.json to set proper Cloudflare Workers types and remove worker-configuration.d.ts
 */
async function modifyTsConfig(projectPath: string): Promise<void> {
  const tsconfigPath = join(projectPath, "tsconfig.json");

  if (!existsSync(tsconfigPath)) {
    return; // No tsconfig.json to modify
  }

  const tsconfigContent = await fs.readFile(tsconfigPath, "utf-8");

  // Set compilerOptions.types to ["@cloudflare/workers-types"]
  const typesEdit = modify(
    tsconfigContent,
    ["compilerOptions", "types"],
    ["@cloudflare/workers-types"],
    {
      formattingOptions: {
        tabSize: 2,
        insertSpaces: true,
        eol: "\n",
      },
    },
  );

  let modifiedContent = applyEdits(tsconfigContent, typesEdit);

  // Parse the JSON to get the current includes array
  const { parseTree, getNodeValue, findNodeAtLocation } = await import(
    "jsonc-parser"
  );
  const tree = parseTree(modifiedContent);
  const includeNode = tree ? findNodeAtLocation(tree, ["include"]) : undefined;
  const currentIncludes = includeNode ? getNodeValue(includeNode) : [];

  // Filter out worker-configuration.d.ts and ensure required files are included
  let newIncludes = Array.isArray(currentIncludes) ? [...currentIncludes] : [];

  // Remove worker-configuration.d.ts if it exists
  newIncludes = newIncludes.filter(
    (include) =>
      include !== "worker-configuration.d.ts" &&
      include !== "./worker-configuration.d.ts",
  );

  // Add required files if they don't already exist
  if (!newIncludes.includes("types/env.ts")) {
    newIncludes.push("types/**/*.ts");
  }
  if (!newIncludes.includes("alchemy.run.ts")) {
    newIncludes.push("alchemy.run.ts");
  }

  // Update the includes array
  const includeEdit = modify(modifiedContent, ["include"], newIncludes, {
    formattingOptions: {
      tabSize: 2,
      insertSpaces: true,
      eol: "\n",
    },
  });

  if (includeEdit.length > 0) {
    modifiedContent = applyEdits(modifiedContent, includeEdit);
  }

  // Format with Prettier
  const prettier = await import("prettier");
  const formatted = await prettier.format(modifiedContent, {
    parser: "json",
    tabWidth: 2,
    useTabs: false,
    semi: true,
    singleQuote: false,
    trailingComma: "none",
  });
  modifiedContent = formatted;

  await fs.writeFile(tsconfigPath, modifiedContent);
}

/**
 * Modifies package.json for website projects to add proper scripts and type: "module"
 */
async function modifyPackageJson(
  projectPath: string,
  pm: PackageManager,
): Promise<void> {
  const packageJsonPath = join(projectPath, "package.json");

  if (!existsSync(packageJsonPath)) {
    return; // No package.json to modify
  }

  const packageJson = {
    type: "module",
    ...JSON.parse(await fs.readFile(packageJsonPath, "utf-8")),
  };

  // Determine deploy command based on package manager
  const deployCommand =
    pm === "bun" ? "bun ./alchemy.run.ts" : "tsx ./alchemy.run.ts";

  // Add/update scripts
  if (!packageJson.scripts) {
    packageJson.scripts = {};
  }

  packageJson.scripts.build = "vite build";
  packageJson.scripts.deploy = deployCommand;
  packageJson.scripts.destroy = `${deployCommand} --destroy`;

  packageJson.scripts = {
    ...Object.fromEntries(
      Object.entries(packageJson.scripts).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
    ),
  };

  // Write back to file with proper formatting
  await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
}
