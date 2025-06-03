import { exec } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const execAsync = promisify(exec);

// Get the root directory of the project
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..", "..");
const examplesDir = join(rootDir, "examples");

interface ExampleProject {
  name: string;
  path: string;
  hasEnvFile: boolean;
  hasAlchemyRunFile: boolean;
  hasIndexFile: boolean;
}

async function discoverExamples(): Promise<ExampleProject[]> {
  const examples: ExampleProject[] = [];

  try {
    const entries = await readdir(examplesDir);

    for (const entry of entries) {
      const examplePath = join(examplesDir, entry);
      const stats = await stat(examplePath);

      if (stats.isDirectory()) {
        // Check for various files
        const envFilePath = join(rootDir, ".env");
        const alchemyRunPath = join(examplePath, "alchemy.run.ts");
        const indexPath = join(examplePath, "index.ts");

        const hasEnvFile = await fileExists(envFilePath);
        const hasAlchemyRunFile = await fileExists(alchemyRunPath);
        const hasIndexFile = await fileExists(indexPath);

        examples.push({
          name: entry,
          path: examplePath,
          hasEnvFile,
          hasAlchemyRunFile,
          hasIndexFile,
        });
      }
    }
  } catch (error) {
    console.error("Failed to discover examples:", error);
    throw error;
  }

  return examples.sort((a, b) => a.name.localeCompare(b.name));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

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

async function verifyNoLocalStateInCI(examplePath: string): Promise<void> {
  const alchemyDir = join(examplePath, ".alchemy");
  const isCloudflareStateStore =
    process.env.ALCHEMY_STATE_STORE === "cloudflare";
  const isCI = process.env.CI === "true";

  if (isCloudflareStateStore && isCI) {
    console.log("Verifying no local state files were created...");
    const alchemyDirExists = await fileExists(alchemyDir);

    if (alchemyDirExists) {
      throw new Error(
        ".alchemy/ directory exists when using Cloudflare state store in CI",
      );
    }
  }
}

const skippedExamples = process.env.CI
  ? // acting up in github CI, will come back to it once it's priority again
    ["aws-app", "cloudflare-worker-bootstrap"]
  : ["aws-app"];

// Discover examples and generate tests
const examples = (await discoverExamples()).filter(
  (e) => !skippedExamples.includes(e.name),
);
console.log(
  `Discovered ${examples.length} example projects:`,
  examples.map((e) => e.name),
);

describe("Smoke Tests", () => {
  // Generate a test for each example
  for (const example of examples) {
    test(`${example.name} - deploy and destroy`, async () => {
      console.log(`--- Processing: ${example.name} ---`);

      let deployCommand: string;
      let destroyCommand: string;

      if (example.hasEnvFile) {
        // Use npm scripts if .env file exists in root
        deployCommand = "bun run deploy";
        destroyCommand = "bun run destroy";
      } else if (example.hasAlchemyRunFile) {
        // Use alchemy.run.ts if it exists
        deployCommand = "bun ./alchemy.run.ts";
        destroyCommand = "bun ./alchemy.run.ts --destroy";
      } else {
        // Fallback to index.ts
        deployCommand = "bun ./index.ts";
        destroyCommand = "bun ./index.ts --destroy";
      }

      try {
        // Run deploy command
        console.log(`Running deploy for ${example.name}...`);
        const deployResult = await runCommand(deployCommand, example.path);
        expect(deployResult).toBeDefined();

        // Verify state store behavior in CI
        await verifyNoLocalStateInCI(example.path);

        // Run destroy command
        console.log(`Running destroy for ${example.name}...`);
        const destroyResult = await runCommand(destroyCommand, example.path);
        expect(destroyResult).toBeDefined();

        // Verify cleanup in CI
        await verifyNoLocalStateInCI(example.path);

        console.log(`--- Completed: ${example.name} ---`);
      } catch (error) {
        console.error(`Failed processing ${example.name}:`, error);
        throw error;
      }
    }, 300000); // 5 minutes timeout per test
  }
});
