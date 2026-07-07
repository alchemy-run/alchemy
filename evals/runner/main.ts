import { existsSync } from "node:fs";
import { join } from "node:path";
import config from "../evals.config.ts";
import { report } from "./report.ts";
import { runCell } from "./run.ts";
import type { HarnessName } from "./types.ts";

const usage = `alchemy evals runner

Usage (run via doppler so ANTHROPIC_API_KEY / CLOUDFLARE_* are injected):

  cd evals
  doppler run -p alchemy-v2 -c dev -- bun runner/main.ts run --task pastebin --oracle
  doppler run -p alchemy-v2 -c dev -- bun runner/main.ts run --task pastebin [--harness claude-code] [--model claude-fable-5] [--trials 1]
  bun runner/main.ts report

Flags for run:
  --task <id>       task under evals/tasks/ (required)
  --oracle          deploy the reference solution instead of running an agent
  --harness <name>  claude-code | codex | opencode | pi (default: enabled harnesses from evals.config.ts)
  --model <id>      model id for the harness (default: from evals.config.ts)
  --trials <n>      trials per cell (default: config.trials)
  --docs-url <url>  docs base handed to the agent (default: https://v2.alchemy.run
                    or DOCS_URL env; point at a deployed website preview to A/B docs edits)
`;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const command = process.argv[2];

if (command === "report") {
  report();
} else if (command === "run") {
  const taskId = flag("task");
  if (!taskId) {
    console.error(usage);
    process.exit(1);
  }
  const taskDir = join(import.meta.dirname, "..", "tasks", taskId);
  if (!existsSync(join(taskDir, "task.json"))) {
    console.error(`Unknown task '${taskId}' (no ${taskDir}/task.json)`);
    process.exit(1);
  }

  const cells: { harness: HarnessName | "oracle"; model: string }[] = [];
  if (has("oracle")) {
    cells.push({ harness: "oracle", model: "n/a" });
  } else if (flag("harness")) {
    const harness = flag("harness") as HarnessName;
    const configured = config.harnesses.find((h) => h.name === harness);
    const model = flag("model") ?? configured?.models[0];
    if (!model) {
      console.error(`No model known for harness '${harness}'; pass --model`);
      process.exit(1);
    }
    cells.push({ harness, model });
  } else {
    for (const harness of config.harnesses.filter((h) => h.enabled)) {
      for (const model of harness.models) {
        cells.push({ harness: harness.name, model });
      }
    }
  }

  const docsUrl =
    flag("docs-url") ?? process.env.DOCS_URL ?? "https://v2.alchemy.run";
  const trials = Number(flag("trials") ?? config.trials);
  for (const cell of cells) {
    for (let trial = 0; trial < trials; trial++) {
      console.log(
        `\n▶ ${taskId} × ${cell.harness} × ${cell.model} (trial ${trial + 1}/${trials})`,
      );
      const record = await runCell({
        taskDir,
        harness: cell.harness,
        model: cell.model,
        budgets: config.budgets,
        docsUrl,
      });
      console.log(
        `  ${record.e2ePass ? "✅ e2ePass" : "❌ fail"} score=${record.score} ` +
          `l3=${record.layers.l3Functional.passed}/${record.layers.l3Functional.total} ` +
          `destroy=${record.layers.destroy.clean ? "clean" : "LEAK"} ` +
          `workspace=${record.workspacePath}`,
      );
    }
  }
} else {
  console.log(usage);
}
