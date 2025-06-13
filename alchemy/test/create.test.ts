import { exec } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { BRANCH_PREFIX } from "./util.ts";

import "../src/test/vitest.ts";

const execAsync = promisify(exec);

// Get the root directory of the project
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..", "..");
const cliPath = join(rootDir, "src", "cli.ts");

async function runCommand(
  command: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  console.log(`Running: ${command} in ${cwd}`);

  try {
    const result = await execAsync(command, {
      cwd,
      timeout: 300000, // 5 minutes timeout
      maxBuffer: 1024 * 1024 * 10, // 10MB buffer
    });
    return result;
  } catch (error: any) {
    console.error(`Command failed: ${command}`);
    console.error(`Error: ${error.message}`);
    if (error.stdout) console.error(`Stdout: ${error.stdout}`);
    if (error.stderr) console.error(`Stderr: ${error.stderr}`);
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function cleanupProject(projectPath: string): Promise<void> {
  try {
    if (await fileExists(projectPath)) {
      await rm(projectPath, { recursive: true, force: true });
    }
  } catch (error) {
    console.warn(`Failed to cleanup ${projectPath}:`, error);
  }
}

const variants = {
  "typescript": "--template=typescript",
  "vite": "--template=vite",
  "astro": "--template=astro",
  "react-router": "--template=react-router",
  "sveltekit": "--template=sveltekit",
};

describe("Create CLI End-to-End Tests", () => {
  // Generate a test for each template variant
  for (const [templateName, templateArg] of Object.entries(variants)) {
    test(`${templateName} - create, deploy, and destroy`, async () => {
      const projectName = `${BRANCH_PREFIX}-create-test-${templateName}`;
      const projectPath = join(rootDir, projectName);
      
      console.log(`--- Processing: ${templateName} template ---`);
      
      try {
        // Cleanup any existing project directory
        await cleanupProject(projectPath);
        
        // Create the project using CLI
        console.log(`Creating ${templateName} project...`);
        const createResult = await runCommand(
          `bun ${cliPath} --name=${projectName} ${templateArg} --yes`,
          rootDir
        );
        expect(createResult).toBeDefined();
        
        // Verify project was created
        const projectExists = await fileExists(projectPath);
        expect(projectExists).toBe(true);
        
        // Verify alchemy.run.ts was created
        const alchemyRunPath = join(projectPath, "alchemy.run.ts");
        const alchemyRunExists = await fileExists(alchemyRunPath);
        expect(alchemyRunExists).toBe(true);
        
        // Try to deploy the project
        console.log(`Deploying ${templateName} project...`);
        const deployResult = await runCommand(
          "bun tsx ./alchemy.run.ts",
          projectPath
        );
        expect(deployResult).toBeDefined();
        
        // Try to destroy the project
        console.log(`Destroying ${templateName} project...`);
        const destroyResult = await runCommand(
          "bun tsx ./alchemy.run.ts --destroy",
          projectPath
        );
        expect(destroyResult).toBeDefined();
        
        console.log(`--- Completed: ${templateName} template ---`);
      } catch (error) {
        console.error(`Failed processing ${templateName}:`, error);
        throw error;
      } finally {
        // Always cleanup the project directory
        await cleanupProject(projectPath);
      }
    }, 600000); // 10 minutes timeout per test
  }
});