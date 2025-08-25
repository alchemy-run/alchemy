import "../src/test/vitest.ts";

import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { describe, expect, test } from "vitest";

// Get the root directory of the project
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, "..", "..");
const cliPath = path.join(rootDir, "alchemy", "bin", "alchemy.js");

async function runCommand(
  command: string,
  cwd: string,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  console.log(`Running: ${command} in ${cwd}`);

  try {
    const result = execSync(command, {
      cwd,
      env: {
        ...process.env,
        ...env,
        DO_NOT_TRACK: "true",
      },
    });
    return { stdout: result.toString(), stderr: "" };
  } catch (error: any) {
    console.error(`Command failed: ${command}`);
    console.error(error.stdout?.toString() ?? "");
    console.error(error.stderr?.toString() ?? "");
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function cleanupProject(projectPath: string): Promise<void> {
  try {
    if (await fileExists(projectPath)) {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  } catch (error) {
    console.warn(`Failed to cleanup ${projectPath}:`, error);
  }
}

const variants = {
  "typescript-template": "--template=typescript",
  "vite-template": "--template=vite",
  "astro-template": "--template=astro",
  "react-router-template": "--template=react-router",
  "sveltekit-template": "--template=sveltekit",
  "rwsdk-template": "--template=rwsdk",
  "tanstack-start-template": "--template=tanstack-start",
  "nuxt-template": "--template=nuxt",
  "hono-template": "--template=hono",
};

describe("Create CLI End-to-End Tests", { concurrent: false }, () => {
  // Generate a test for each template variant
  for (const [templateName, templateArg] of Object.entries(variants)) {
    test(`${templateName} - create, deploy, and destroy`, async () => {
      const smokeDir = path.join(rootDir, ".smoke");
      const projectPath = path.join(smokeDir, templateName);

      console.log(`--- Processing: ${templateName} template ---`);

      // Cleanup smoke directory if it exists
      await cleanupProject(smokeDir);

      try {
        // Ensure smoke directory exists
        await fs.mkdir(smokeDir, { recursive: true });

        // Cleanup any existing project directory
        await cleanupProject(projectPath);

        // Create the project using CLI - run from smoke directory
        console.log(`Creating ${templateName} project...`);
        const createResult = await runCommand(
          `bun ${cliPath} create ${templateName} ${templateArg} --vibe-rules=cursor --no-git --github-actions --no-install --yes`,
          smokeDir, // Run from smoke directory so project is created there
          {
            NODE_ENV: "test",
          },
        );
        expect(createResult).toBeDefined();

        // patch the package.json to use the catalog workspaces so that we can install alchemy from the workspace
        const packageJson = JSON.parse(
          await fs.readFile(path.join(projectPath, "package.json"), "utf-8"),
        );
        packageJson.workspaces = {
          catalog: JSON.parse(await fs.readFile("package.json", "utf-8"))
            .workspaces.catalog,
        };
        await fs.writeFile(
          path.join(projectPath, "package.json"),
          JSON.stringify(packageJson, null, 2),
        );

        await runCommand("bun i", projectPath);

        // Try to deploy the project
        console.log(`Deploying ${templateName} project...`);
        const deployResult = await runCommand(
          "bun run deploy --adopt",
          projectPath,
        );
        expect(deployResult).toBeDefined();

        // Try to destroy the project
        console.log(`Destroying ${templateName} project...`);
        const destroyResult = await runCommand("bun run destroy", projectPath);
        expect(destroyResult).toBeDefined();

        console.log(`--- Completed: ${templateName} template ---`);
      } catch (error) {
        console.error(`Failed processing ${templateName}:`, error);
        throw error;
      } finally {
        if (!process.env.NO_CLEANUP) {
          // Always cleanup the project directory
          // await cleanupProject(projectPath);
        }
      }
    }, 600000); // 10 minutes timeout per test
  }
});
