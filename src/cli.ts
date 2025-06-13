#!/usr/bin/env node

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { select, input, confirm } from "@inquirer/prompts";

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

// Parse CLI arguments
function parseCliArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {};
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--version' || arg === '-v') {
      options.version = true;
    } else if (arg === '--yes' || arg === '-y') {
      options.yes = true;
    } else if (arg === '--overwrite') {
      options.overwrite = true;
    } else if (arg.startsWith('--name=')) {
      options.name = arg.split('=')[1];
    } else if (arg.startsWith('--template=')) {
      options.template = arg.split('=')[1];
    }
  }
  
  return options;
}

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
    },
    npm: {
      init: "npm init -y",
      install: "npm install",
      add: "npm install",
      addDev: "npm install --save-dev",
      run: "npx",
      create: "npm create",
    },
    pnpm: {
      init: "pnpm init",
      install: "pnpm install",
      add: "pnpm add",
      addDev: "pnpm add -D",
      run: "pnpm",
      create: "pnpm create",
    },
    yarn: {
      init: "yarn init -y",
      install: "yarn install",
      add: "yarn add",
      addDev: "yarn add -D",
      run: "yarn",
      create: "yarn create",
    },
  };

  return commands[pm];
}

// Template definitions
interface Template {
  name: string;
  description: string;
  init: (pm: PackageManager, projectName: string, projectPath: string) => Promise<void>;
}

function createAlchemyRunTs(template: string, projectName: string): string {
  const templates = {
    typescript: `/// <reference types="@types/node" />

import alchemy from "alchemy";
import { Worker } from "alchemy/cloudflare";

const app = await alchemy("${projectName}", {
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
});

export const worker = await Worker("${projectName}-worker", {
  entrypoint: "./src/worker.ts",
});

console.log(worker.url);

await app.finalize();
`,

    vite: `/// <reference types="@types/node" />

import alchemy from "alchemy";
import { Vite } from "alchemy/cloudflare";

const app = await alchemy("${projectName}", {
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
});

export const website = await Vite("${projectName}-website", {
  main: "./src/index.ts",
  command: "${detectPackageManager() === "bun" ? "bun" : "npm"} run build",
});

console.log({
  url: website.url,
});

await app.finalize();
`,

    astro: `/// <reference types="@types/node" />

import alchemy from "alchemy";
import { Astro, KVNamespace, R2Bucket } from "alchemy/cloudflare";

const app = await alchemy("${projectName}", {
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
});

// Create some Cloudflare resources for your app
export const [storage, cache] = await Promise.all([
  R2Bucket("${projectName}-storage", {
    allowPublicAccess: false,
  }),
  KVNamespace("CACHE", {
    title: "${projectName}-cache",
  }),
]);

export const website = await Astro("${projectName}-website", {
  command: "${detectPackageManager() === "bun" ? "bun" : "npm"} run build",
  bindings: {
    STORAGE: storage,
    CACHE: cache,
  },
});

console.log({
  url: website.url,
});

await app.finalize();
`,

    "react-router": `/// <reference types="@types/node" />

import alchemy from "alchemy";
import { ReactRouter } from "alchemy/cloudflare";

const app = await alchemy("${projectName}", {
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
});

export const website = await ReactRouter("${projectName}-website", {
  command: "${detectPackageManager() === "bun" ? "bun" : "npm"} run build",
});

console.log({
  url: website.url,
});

await app.finalize();
`,

    sveltekit: `/// <reference types="@types/node" />

import alchemy from "alchemy";
import { SvelteKit } from "alchemy/cloudflare";

const app = await alchemy("${projectName}", {
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
});

export const website = await SvelteKit("${projectName}-website", {
  command: "${detectPackageManager() === "bun" ? "bun" : "npm"} run build",
});

console.log({
  url: website.url,
});

await app.finalize();
`,

    "tanstack-start": `/// <reference types="@types/node" />

import alchemy from "alchemy";
import { TanStackStart } from "alchemy/cloudflare";

const app = await alchemy("${projectName}", {
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
});

export const website = await TanStackStart("${projectName}-website", {
  command: "${detectPackageManager() === "bun" ? "bun" : "npm"} run build",
});

console.log({
  url: website.url,
});

await app.finalize();
`,

    redwood: `/// <reference types="@types/node" />

import alchemy from "alchemy";
import { Redwood } from "alchemy/cloudflare";

const app = await alchemy("${projectName}", {
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
});

export const website = await Redwood("${projectName}-website", {
  command: "${detectPackageManager() === "bun" ? "bun" : "npm"} run build",
});

console.log({
  url: website.url,
});

await app.finalize();
`,

    nuxt: `/// <reference types="@types/node" />

import alchemy from "alchemy";
import { Nuxt } from "alchemy/cloudflare";

const app = await alchemy("${projectName}", {
  phase: process.argv.includes("--destroy") ? "destroy" : "up",
});

export const website = await Nuxt("${projectName}-website", {
  command: "${detectPackageManager() === "bun" ? "bun" : "npm"} run build",
});

console.log({
  url: website.url,
});

await app.finalize();
`,
  };

  return templates[template as keyof typeof templates] || templates.typescript;
}

function execCommand(command: string, cwd: string): void {
  console.log(`Running: ${command}`);
  try {
    execSync(command, { stdio: "inherit", cwd });
  } catch (error) {
    console.error(`Failed to execute: ${command}`);
    process.exit(1);
  }
}

async function initTypescriptProject(pm: PackageManager, projectName: string, projectPath: string): Promise<void> {
  const commands = getPackageManagerCommands(pm);
  
  // Initialize project
  execCommand(commands.init, projectPath);
  
  // Install dependencies
  execCommand(`${commands.addDev} alchemy @cloudflare/workers-types @types/node typescript`, projectPath);
  
  // Create basic project structure
  await fs.mkdir(join(projectPath, "src"), { recursive: true });
  
  // Create worker.ts
  await fs.writeFile(join(projectPath, "src", "worker.ts"), `export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response("Hello World from ${projectName}!");
  },
};
`);

  // Create tsconfig.json
  await fs.writeFile(join(projectPath, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2020",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      types: ["@cloudflare/workers-types", "@types/node"]
    },
    include: ["src/**/*", "alchemy.run.ts"]
  }, null, 2));
}

async function initViteProject(pm: PackageManager, projectName: string, projectPath: string): Promise<void> {
  const commands = getPackageManagerCommands(pm);
  
  // Use cloudflare create command for Vite
  execCommand(`${commands.create} cloudflare@latest ${projectName} --framework=react --platform=workers --no-deploy`, process.cwd());
  
  // Install alchemy dependencies
  execCommand(`${commands.addDev} alchemy`, projectPath);
  
  // Remove unnecessary files
  if (existsSync(join(projectPath, "worker-configuration.d.ts"))) {
    await fs.unlink(join(projectPath, "worker-configuration.d.ts"));
  }
  if (existsSync(join(projectPath, "wrangler.jsonc"))) {
    await fs.unlink(join(projectPath, "wrangler.jsonc"));
  }

  // Create env.ts for proper typing
  await fs.mkdir(join(projectPath, "src"), { recursive: true });
  await fs.writeFile(join(projectPath, "src", "env.ts"), `import type { website } from "../alchemy.run.ts";

export type CloudflareEnv = typeof website.Env;

declare global {
  type Env = CloudflareEnv;
}

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends CloudflareEnv {}
  }
}
`);
}

async function initAstroProject(pm: PackageManager, projectName: string, projectPath: string): Promise<void> {
  const commands = getPackageManagerCommands(pm);
  
  // Create Astro project
  execCommand(`${commands.create} astro@latest ${projectPath} --template=minimal --typescript=strict --no-install`, process.cwd());
  
  // Install dependencies
  execCommand(`${commands.install}`, projectPath);
  execCommand(`${commands.add} @astrojs/cloudflare`, projectPath);
  execCommand(`${commands.addDev} alchemy @cloudflare/workers-types`, projectPath);

  // Update astro.config.mjs
  await fs.writeFile(join(projectPath, "astro.config.mjs"), `import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
});
`);

  // Create env.d.ts
  await fs.mkdir(join(projectPath, "src"), { recursive: true });
  await fs.writeFile(join(projectPath, "src", "env.d.ts"), `/// <reference types="astro/client" />

import type { website } from "../alchemy.run.ts";

type CloudflareEnv = typeof website.Env;

declare namespace App {
  interface Locals extends CloudflareEnv {}
}
`);

  // Create API route example
  await fs.mkdir(join(projectPath, "src", "pages", "api"), { recursive: true });
  await fs.writeFile(join(projectPath, "src", "pages", "api", "hello.ts"), `import type { APIRoute } from 'astro';

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
`);
}

async function initReactRouterProject(pm: PackageManager, projectName: string, projectPath: string): Promise<void> {
  const commands = getPackageManagerCommands(pm);
  
  // Use cloudflare create command for React Router
  execCommand(`${commands.create} cloudflare@latest ${projectName} --framework=react-router`, process.cwd());
  
  // Remove unnecessary files
  if (existsSync(join(projectPath, "worker-configuration.d.ts"))) {
    await fs.unlink(join(projectPath, "worker-configuration.d.ts"));
  }
  if (existsSync(join(projectPath, "wrangler.jsonc"))) {
    await fs.unlink(join(projectPath, "wrangler.jsonc"));
  }

  // Install alchemy dependencies
  execCommand(`${commands.add} alchemy cloudflare`, projectPath);
  execCommand(`${commands.addDev} @cloudflare/workers-types`, projectPath);

  // Create env.ts for proper typing
  await fs.mkdir(join(projectPath, "workers"), { recursive: true });
  await fs.writeFile(join(projectPath, "workers", "env.ts"), `import type { website } from "../alchemy.run.ts";

export type CloudflareEnv = typeof website.Env;

declare global {
  type Env = CloudflareEnv;
}

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends CloudflareEnv {}
  }
}
`);
}

async function initSvelteKitProject(pm: PackageManager, projectName: string, projectPath: string): Promise<void> {
  const commands = getPackageManagerCommands(pm);
  
  // Create SvelteKit project
  execCommand(`${commands.create} svelte@latest ${projectName}`, process.cwd());
  
  // Install dependencies
  execCommand(`${commands.install}`, projectPath);
  execCommand(`${commands.add} @sveltejs/adapter-cloudflare alchemy cloudflare`, projectPath);
  execCommand(`${commands.addDev} @cloudflare/workers-types`, projectPath);

  // Update svelte.config.js
  await fs.writeFile(join(projectPath, "svelte.config.js"), `import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
\tpreprocess: vitePreprocess(),
\tkit: {
\t\tadapter: adapter()
\t}
};

export default config;
`);

  // Create vite.config.ts
  await fs.writeFile(join(projectPath, "vite.config.ts"), `import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
\tplugins: [sveltekit()],
});
`);

  // Create env.ts for proper typing
  await fs.mkdir(join(projectPath, "src"), { recursive: true });
  await fs.writeFile(join(projectPath, "src", "env.ts"), `import type { website } from "../alchemy.run.ts";

export type CloudflareEnv = typeof website.Env;

declare global {
  type Env = CloudflareEnv;
}

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends CloudflareEnv {}
  }
}
`);
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

async function main() {
  const options = parseCliArgs();
  
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
        if (!/^[a-z0-9-_]+$/i.test(input)) return "Project name can only contain letters, numbers, hyphens, and underscores";
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
    console.error("Error: Project name can only contain letters, numbers, hyphens, and underscores");
    process.exit(1);
  }

  // Get template (interactive or from CLI args)
  let template: string;
  if (options.template) {
    template = options.template;
    console.log(`Using template: ${template}`);
    // Validate template exists
    if (!templates.find((t) => t.name === template)) {
      console.error(`Error: Template '${template}' not found. Available templates: ${templates.map(t => t.name).join(', ')}`);
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
      console.log(`Directory ${projectName} already exists. Overwriting due to CLI flag.`);
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

  // Create alchemy.run.ts
  const alchemyRunContent = createAlchemyRunTs(template, projectName);
  await fs.writeFile(join(projectPath, "alchemy.run.ts"), alchemyRunContent);

  // Create .gitignore if it doesn't exist
  const gitignorePath = join(projectPath, ".gitignore");
  if (!existsSync(gitignorePath)) {
    await fs.writeFile(gitignorePath, `node_modules/
.env
.env.local
dist/
lib/
.wrangler/
wrangler.jsonc
*.tsbuildinfo
`);
  }

  console.log(`\n✅ Project ${projectName} created successfully!`);
  console.log(`\n📁 Navigate to your project:`);
  console.log(`   cd ${projectName}`);
  console.log(`\n🚀 Deploy your project:`);
  console.log(`   ${pm} ./alchemy.run`);
  console.log(`\n🧹 Destroy your project:`);
  console.log(`   ${pm} ./alchemy.run --destroy`);
  console.log(`\n📚 Learn more: https://alchemy.run`);
}

// CLI arguments are now handled in main() function

// Run the main function
main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});