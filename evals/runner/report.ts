import { readRuns } from "./journal.ts";

export function report(): void {
  const runs = readRuns();
  if (runs.length === 0) {
    console.log("No runs recorded yet (results/runs.jsonl is empty).");
    return;
  }
  const rows = runs.map((run) => ({
    run: run.runId,
    task: run.taskId,
    harness: `${run.harness}@${run.harnessVersion.split(" ")[0]}`,
    model: run.model,
    e2e: run.e2ePass ? "PASS" : "fail",
    score: run.score,
    l3: `${run.layers.l3Functional.passed}/${run.layers.l3Functional.total}`,
    tests: run.layers.l5AgentTests.passed
      ? "pass"
      : run.layers.l5AgentTests.present
        ? "fail"
        : "none",
    destroy: run.layers.destroy.clean ? "clean" : "LEAK",
    turns: run.turns ?? "-",
    "$agent": run.agentCostUsd?.toFixed(2) ?? "-",
    minutes: (run.agentWallClockMs / 60_000).toFixed(1),
  }));
  console.table(rows);

  const byCell = new Map<string, { pass: number; total: number }>();
  for (const run of runs) {
    const key = `${run.taskId} × ${run.harness} × ${run.model}`;
    const cell = byCell.get(key) ?? { pass: 0, total: 0 };
    cell.total += 1;
    if (run.e2ePass) cell.pass += 1;
    byCell.set(key, cell);
  }
  console.log("\npass@1 by cell:");
  for (const [key, cell] of byCell) {
    console.log(
      `  ${key}: ${cell.pass}/${cell.total} (${Math.round((100 * cell.pass) / cell.total)}%)`,
    );
  }
}
