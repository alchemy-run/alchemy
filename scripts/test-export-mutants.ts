/**
 * The Domain Export mutation gate: every mutant in
 * `packages/integration-tests/test/DomainExport/mutation/mutants.ts` must be
 * killed by the suite named beside it. Each mutant runs that suite in a
 * process of its own, with `mutate.preload.ts` applying the edit as Bun
 * loads the source (the file on disk never changes). A mutant passes only
 * if it applied (its text occurs exactly once; the preload records this)
 * and a case of its suite then failed. A suite that ran no case (it
 * crashed, or its tier was not selected) proves nothing and fails the gate.
 *
 * Suites in `test/DomainExport` start Docker containers; mutants whose suite
 * is opt-in (`--tags export-lakes`) run only with `--lakes`.
 * `EXPORT_TEST_RUNS` reaches every suite, for a quicker or deeper gate.
 *
 * `--list` prints the selected mutants; `--dry-run` prints each command.
 * `--only <id-prefix>` selects mutants by id (e.g. `--only iceberg/`).
 *
 * Usage: node scripts/test-export-mutants.ts [--list] [--dry-run] [--lakes] [--only <prefix>]
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Command, Flag } from "effect/cli";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

/** What the gate reads of `mutants.ts`, which belongs to the integration-tests project. */
const MutantsModule = Schema.Struct({
  mutants: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      suite: Schema.String,
      why: Schema.String,
      tags: Schema.String.pipe(Schema.Array, Schema.optionalKey),
    }),
  ),
});

const LABEL = "test:export:mutants";

/** Ends the run with `code` after the reason has already been printed. */
class ExitWith extends Data.TaggedError("ExitWith")<{ readonly code: number }> {
  readonly [Runtime.errorReported] = false;
  get [Runtime.errorExitCode]() {
    return this.code;
  }
}

/** What one mutant's run showed. Only `Killed` passes. */
type Verdict =
  | { readonly _tag: "Killed" }
  | { readonly _tag: "Survived" }
  /** The suite ran no case (it crashed, or its tier did not run): proof of nothing. */
  | { readonly _tag: "NoCaseRan"; readonly detail: string }
  | { readonly _tag: "Unapplied"; readonly detail: string };

const command = Command.make(
  "test-export-mutants",
  {
    list: Flag.Boolean("list").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print the selected mutants without running anything"),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print each mutant's command without running it"),
    ),
    lakes: Flag.Boolean("lakes").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Include mutants whose suite is opt-in (`--tags export-lakes`)"),
    ),
    only: Flag.String("only").pipe(
      Flag.optional,
      Flag.withDescription("Run only mutants whose id starts with this prefix"),
    ),
  },
  Effect.fn(function* (options) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner;

    const repoRoot = path.resolve(import.meta.dirname, "..");
    const testPackageRoot = path.join(repoRoot, "packages/integration-tests");
    const runner = path.join(repoRoot, "packages/alchemy-test/bin/alchemy-test.ts");
    const preload = path.join(testPackageRoot, "test/DomainExport/mutation/mutate.preload.ts");
    const { mutants } = yield* Effect.promise(
      () => import(path.join(testPackageRoot, "test/DomainExport/mutation/mutants.ts")),
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(MutantsModule)), Effect.orDie);

    const selected = mutants.filter(
      (mutant) =>
        (options.lakes || mutant.tags === undefined) &&
        Option.match(options.only, {
          onNone: () => true,
          onSome: (prefix) => mutant.id.startsWith(prefix),
        }),
    );
    if (selected.length === 0) {
      yield* Console.error(`${LABEL}: no mutant selected`);
      return yield* new ExitWith({ code: 1 });
    }
    if (options.list) {
      for (const mutant of selected)
        yield* Console.log(`${mutant.id}\t${mutant.suite}\t${mutant.why}`);
      return;
    }

    // The preload must load before the runner's own entry: the `.bin` shim drops `--preload`.
    const argvOf = (mutant: (typeof selected)[number]) => [
      "--preload",
      preload,
      runner,
      path.join("test", mutant.suite),
      "--retry",
      "0",
      ...(mutant.tags ?? []).flatMap((tag) => ["--tags", tag]),
    ];

    const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "export-mutants-" });
    const verdicts: Array<{ readonly id: string; readonly verdict: Verdict }> = [];
    for (const mutant of selected) {
      if (options.dryRun) {
        yield* Console.log(`EXPORT_MUTANT=${mutant.id} bun ${argvOf(mutant).join(" ")}`);
        continue;
      }
      const marker = path.join(tmp, mutant.id.replaceAll("/", "_"));
      yield* Console.log(`${LABEL}: ${mutant.id} (${mutant.suite})`);
      const { exitCode, output } = yield* Effect.scoped(
        spawner
          .spawn(
            ChildProcess.make("bun", argvOf(mutant), {
              cwd: testPackageRoot,
              env: { ...process.env, EXPORT_MUTANT: mutant.id, EXPORT_MUTANT_MARKER: marker },
              stdout: "pipe",
              stderr: "pipe",
            }),
          )
          .pipe(
            Effect.flatMap((child) =>
              Effect.all({
                exitCode: child.exitCode,
                output: child.stdout.pipe(Stream.decodeText, Stream.mkString),
              }),
            ),
          ),
      );
      const recorded = (yield* fs.readFileString(marker).pipe(Effect.orElseSucceed(() => "")))
        .trim()
        .split("\n");
      const summary = /Tests: (\d+) failed \| (\d+) passed/.exec(output);
      const verdict: Verdict = !recorded.includes(`applied ${mutant.id}`)
        ? { _tag: "Unapplied", detail: recorded.join("; ") || "the source never loaded" }
        : summary === null || Number(summary[1]) + Number(summary[2]) === 0
          ? { _tag: "NoCaseRan", detail: output.trim().split("\n").slice(-3).join(" ") }
          : exitCode !== 0 && Number(summary[1]) > 0
            ? { _tag: "Killed" }
            : { _tag: "Survived" };
      verdicts.push({ id: mutant.id, verdict });
      yield* Console.log(
        `${LABEL}: ${mutant.id} ${verdict._tag.toLowerCase()}${"detail" in verdict ? `: ${verdict.detail}` : ""}`,
      );
    }
    if (options.dryRun) return;

    const failed = verdicts.filter(({ verdict }) => verdict._tag !== "Killed");
    yield* Console.log(`${LABEL}: ${verdicts.length - failed.length}/${verdicts.length} killed`);
    if (failed.length > 0) {
      for (const { id, verdict } of failed) yield* Console.error(`${LABEL}: ${id} ${verdict._tag}`);
      return yield* new ExitWith({ code: 1 });
    }
  }, Effect.scoped),
).pipe(Command.withDescription("Run the Domain Export mutation gate"));

Stdio.Stdio.use(({ args }) =>
  Effect.flatMap(args, (argv) => Command.runWith(command, { version: "0.0.0" })(argv)),
).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
