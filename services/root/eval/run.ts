/**
 * THE EVAL HARNESS — scenarios and data against the task system's
 * typesafe control logic, scripted (the desk world) or live (the real
 * stack, with the board UI open for a human in the loop).
 *
 * ```sh
 * bun eval/run.ts all                     # every scenario, scripted
 * bun eval/run.ts routing                 # one scenario, scripted
 * bun eval/run.ts routing --live --cap 3  # small live smoke
 * bun eval/run.ts width --live --ui       # live, watching the board
 * bun eval/run.ts --report-only eval/reports/<file>.json
 * ```
 *
 * Flags: `--live` (real stack), `--ui` (open the board, stream
 * status), `--fresh-board` (score this run's ids only — the default
 * behavior, made explicit), `--width N` (override the scenario's desk
 * width), `--cap N` (file only the first N arrivals),
 * `--report-only <file>` (re-print a saved report).
 */
import * as fs from "node:fs";
import { runLive } from "./live.ts";
import { printReport, writeReport, type ScenarioReport } from "./report.ts";
import { SCENARIOS, scenarioByName } from "./scenarios/index.ts";
import { runScripted } from "./scripted.ts";

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const valueOf = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const positional = args.filter(
  (arg, index) =>
    !arg.startsWith("--") &&
    args[index - 1] !== "--width" &&
    args[index - 1] !== "--cap" &&
    args[index - 1] !== "--report-only",
);

const reportOnly = valueOf("--report-only");
if (reportOnly !== undefined) {
  const report = JSON.parse(
    fs.readFileSync(reportOnly, "utf8"),
  ) as ScenarioReport;
  printReport(report);
  process.exit(0);
}

const target = positional[0];
if (target === undefined) {
  console.log(
    `usage: bun eval/run.ts <scenario|all> [--live] [--ui] [--fresh-board] [--width N] [--cap N] [--report-only <file>]\n` +
      `scenarios:\n${SCENARIOS.map(
        (scenario) => `  ${scenario.name.padEnd(14)} ${scenario.description}`,
      ).join("\n")}`,
  );
  process.exit(1);
}

const selected =
  target === "all"
    ? SCENARIOS
    : (() => {
        const scenario = scenarioByName(target);
        if (scenario === undefined) {
          console.error(
            `unknown scenario "${target}" — one of: all, ${SCENARIOS.map((s) => s.name).join(", ")}`,
          );
          process.exit(1);
        }
        return [scenario];
      })();

const live = flags.has("--live");
const widthRaw = valueOf("--width");
const capRaw = valueOf("--cap");
const options = {
  ...(widthRaw === undefined ? {} : { width: Number(widthRaw) }),
  ...(capRaw === undefined ? {} : { cap: Number(capRaw) }),
};

let failures = 0;
for (const scenario of selected) {
  const report = live
    ? await runLive(scenario, {
        ...options,
        ui: flags.has("--ui"),
        freshBoard: flags.has("--fresh-board"),
      })
    : await runScripted(scenario, options);
  const file = writeReport(report);
  printReport(report, file);
  const m = report.metrics;
  if (
    m.outcomes.matched < m.outcomes.expected ||
    m.routing.hits < m.routing.total ||
    report.judgedMisses.length > 0
  ) {
    failures += 1;
  }
}
process.exit(failures > 0 ? 1 : 0);
