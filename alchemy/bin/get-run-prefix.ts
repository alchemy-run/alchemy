import { detectRuntime } from "../src/util/detect-node-runtime.ts";
import { detectPackageManager } from "../src/util/detect-package-manager.ts";

export async function getRunPrefix(options?: {
  isTypeScript?: boolean;
  cwd?: string;
}) {
  const packageManager = await detectPackageManager(
    options?.cwd ?? process.cwd(),
  );
  const runtime = detectRuntime();

  // Determine the command to run based on package manager and runtime
  let command: string;

  switch (packageManager) {
    case "bun":
      command = "bun";
      break;
    case "deno":
      command = "deno run -A";
      break;
    case "pnpm":
      command = options?.isTypeScript ? "pnpm dlx tsx" : "pnpm node";
      break;
    case "yarn":
      command = options?.isTypeScript ? "yarn tsx" : "yarn node";
      break;
    default:
      switch (runtime) {
        case "bun":
          command = "bun";
          break;
        case "deno":
          command = "deno run -A";
          break;
        default:
          command = options?.isTypeScript ? "npx tsx" : "npx node";
          break;
      }
  }

  return command;
}
