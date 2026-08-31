import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";
import { Progress } from "../../Alchemist/Progress.ts";
import * as Nuke from "../../Alchemist/routes/nuke.ts";
import * as CliKit from "../../Cli/CliKit/index.ts";
import { formatElapsed } from "../Format.ts";
import { confirmOrDecline } from "./confirm.ts";
import { UserInputError } from "./errors.ts";
import { config, envFile, profile, yes } from "./flags.ts";
import { instrumentCommand } from "./instrument.ts";

const includeFlag = Flag.string("include").pipe(
  Flag.withDescription("Glob of provider IDs to include (repeatable)"),
  Flag.atLeast(0),
);
const excludeFlag = Flag.string("exclude").pipe(
  Flag.withDescription("Glob of provider IDs to exclude (repeatable)"),
  Flag.atLeast(0),
);
const filterFlag = Flag.string("filter").pipe(
  Flag.withDescription(
    "JavaScript expression evaluated with resource in scope; matching resources are excluded from deletion (repeatable)",
  ),
  Flag.atLeast(0),
);
const verboseFlag = Flag.boolean("verbose").pipe(
  Flag.withDescription("List every individual resource"),
  Flag.withDefault(false),
);
const concurrencyFlag = Flag.integer("concurrency").pipe(
  Flag.withDescription(
    "Maximum providers processed in parallel; 0 is unbounded",
  ),
  Flag.withDefault(16),
  Flag.map((value): number | "unbounded" => (value <= 0 ? "unbounded" : value)),
);
const timeoutFlag = Flag.integer("timeout").pipe(
  Flag.withDescription("Per-provider timeout in seconds"),
  Flag.withDefault(120),
  Flag.map(Duration.seconds),
);
const independentFlag = Flag.boolean("independent").pipe(
  Flag.withDescription("Retry each resource independently"),
  Flag.withDefault(false),
);
const retriesFlag = Flag.integer("retries").pipe(
  Flag.withDescription("Independent retries per resource"),
  Flag.withDefault(10),
);
const localFlag = Flag.boolean("local").pipe(
  Flag.withDescription("Target only locally emulated providers"),
  Flag.withDefault(false),
);
const dryRunFlag = Flag.boolean("dry-run").pipe(
  Flag.withDescription("Scan and show targets without deleting"),
  Flag.withDefault(false),
);

// A broken filter must abort the nuke, not silently widen the kill list:
// compile and evaluation errors both fail the command before any deletion.
const compileFilter = (expression: string) =>
  Effect.try({
    try: () =>
      new Function(
        "scope",
        `with (scope) { return (${expression}); }`,
      ) as (scope: { resource: Record<string, unknown> }) => unknown,
    catch: (cause) =>
      new UserInputError({
        message: `--filter expression ${JSON.stringify(expression)} failed to compile: ${cause}`,
      }),
  }).pipe(
    Effect.map(
      (predicate) => (resource: Record<string, unknown>) =>
        Effect.try({
          try: () => Boolean(predicate({ resource })),
          catch: (cause) =>
            new UserInputError({
              message: `--filter expression ${JSON.stringify(expression)} threw while evaluating a resource: ${cause}`,
            }),
        }),
    ),
  );

const nukeCommand = Command.make(
  "nuke",
  {
    main: config,
    envFile,
    profile,
    yes,
    dryRun: dryRunFlag,
    verbose: verboseFlag,
    concurrency: concurrencyFlag,
    timeout: timeoutFlag,
    independent: independentFlag,
    retries: retriesFlag,
    include: includeFlag,
    exclude: excludeFlag,
    filter: filterFlag,
    local: localFlag,
  },
  instrumentCommand(
    "unsafe.nuke",
    (args: { profile: string | undefined; main: string }) => ({
      "alchemy.profile": args.profile ?? "",
      "alchemy.main": args.main,
    }),
  )(
    Effect.fn(function* (args) {
      const scan = yield* Nuke.scan({
        entrypoint: args.main,
        profile: args.profile,
        envFile: Option.getOrUndefined(args.envFile),
        mode: args.local ? "local" : "live",
        include: args.include,
        exclude: args.exclude,
        concurrency: args.concurrency,
        providerTimeoutSeconds: Duration.toSeconds(args.timeout),
      }).pipe(
        // One line per provider as its listing settles — the scan fans out
        // across every provider and is often the slowest part of a nuke.
        Effect.provideService(Progress, (event) =>
          event._tag === "nuke.scan.provider.completed"
            ? Console.log(`scanned ${event.provider} (${event.resources})`)
            : Effect.void,
        ),
      );
      for (const item of scan.failures) {
        yield* CliKit.accessors.output.warning(
          `${item.provider}: ${item.message}`,
        );
      }

      const predicates = yield* Effect.forEach(args.filter, compileFilter);
      const targets: Array<(typeof scan.resources)[number]> = [];
      for (const resource of scan.resources) {
        const matches = yield* Effect.forEach(predicates, (predicate) =>
          predicate({
            ...resource.attributes,
            Type: resource.providerId,
            LogicalId: resource.displayName,
          }),
        );
        if (!matches.some(Boolean)) targets.push(resource);
      }
      const byProvider = new Map<string, typeof targets>();
      for (const target of targets) {
        byProvider.set(target.providerId, [
          ...(byProvider.get(target.providerId) ?? []),
          target,
        ]);
      }
      yield* Console.log("");
      for (const [providerId, resources] of [...byProvider.entries()].sort(
        ([a], [b]) => a.localeCompare(b),
      )) {
        yield* Console.log(`${providerId}  ${resources.length} to delete`);
        if (args.verbose) {
          for (const resource of resources) {
            yield* Console.log(`  - ${resource.displayName}`);
          }
        }
      }
      yield* Console.log("");
      yield* Console.log(`${targets.length} resource(s) to delete.`);
      if (targets.length === 0) {
        yield* CliKit.accessors.output.info("Nothing to delete.");
        return;
      }
      if (args.dryRun) {
        yield* Console.log("Dry run complete: nothing was deleted.");
        return;
      }
      yield* confirmOrDecline({
        yes: args.yes,
        message: `Permanently DELETE ${targets.length} ${args.local ? "locally emulated " : ""}resource(s)? This cannot be undone.`,
        confirmLabel: "Delete",
        cancelLabel: "Cancel",
      });

      const deleteStartedAt = yield* Clock.currentTimeMillis;
      const result = yield* Nuke.execute({
        scan,
        resources: targets,
        strategy: args.independent
          ? { _tag: "independent", retries: args.retries }
          : { _tag: "coordinated" },
        concurrency: args.concurrency,
        providerTimeoutSeconds: Duration.toSeconds(args.timeout),
      }).pipe(
        // One line per confirmed deletion — a long nuke was previously
        // silent until the final summary in both renderers.
        Effect.provideService(Progress, (event) =>
          event._tag === "nuke.resource.deleted"
            ? Console.log(`deleted ${event.resource}`)
            : event._tag === "nuke.resource.failed"
              ? Console.log(`failed ${event.resource}: ${event.message}`)
              : Effect.void,
        ),
      );
      const deleteElapsed = (yield* Clock.currentTimeMillis) - deleteStartedAt;
      yield* CliKit.accessors.output.success(
        `Deleted ${result.deleted.length} resource(s) over ${result.passes} pass(es) (${formatElapsed(deleteElapsed)}).`,
      );
      if (result.held.length > 0) {
        yield* CliKit.accessors.output.warning(
          `${result.held.length} resource(s) were held back.`,
        );
      }
      if (result.failed.length > 0) {
        yield* CliKit.accessors.output.error(
          `${result.failed.length} resource(s) could not be deleted.`,
        );
      }
    }),
  ),
).pipe(
  Command.withDescription(
    "Enumerate resources across the stack providers and delete them",
  ),
  Command.unlisted,
);

export const unsafeCommand = Command.make("unsafe", {}).pipe(
  Command.withDescription("Dangerous, irreversible operations"),
  Command.withSubcommands([nukeCommand]),
  Command.unlisted,
);
