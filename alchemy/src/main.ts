#!/usr/bin/env bun
import { parseArgs } from "util";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    help: {
      type: "boolean",
      short: "h",
    },
  },
  strict: true,
  allowPositionals: true,
});

if (values.help || positionals.length === 0) {
  console.error("Usage: iac <command> [args]");
  console.error("\nCommands:");
  console.error("  destroy [stack names]  Delete the specified stacks");
  process.exit(1);
}

const [command, ...restArgs] = positionals;

if (command.toLowerCase() === "destroy") {
  if (restArgs.length === 0) {
    console.error("Error: Please specify at least one stack name to destroy");
    process.exit(1);
  }
  console.log("Deleting stacks:", restArgs);
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
