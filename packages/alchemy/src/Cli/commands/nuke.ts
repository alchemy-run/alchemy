import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";
import { NukeControl } from "../../AlchemyControl/NukeControl.ts";
import * as Operation from "../../AlchemyControl/Operation.ts";
import * as CliKit from "../../Cli/CliKit/index.ts";
import { resolveProfileName } from "../ProfileSelection.ts";
import {
  config,
  envFile,
  exitDeclined,
  instrumentCommand,
  profile,
  yes,
} from "./_shared.ts";

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
    "JavaScript expression evaluated with resource in scope",
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

const compileFilter = (expression: string) => {
  const predicate = new Function(
    "scope",
    `with (scope) { return (${expression}); }`,
  ) as (scope: { resource: Record<string, unknown> }) => unknown;
  return (resource: Record<string, unknown>) => {
    try {
      return Boolean(predicate({ resource }));
    } catch {
      return false;
    }
  };
};

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
      const profileName = yield* resolveProfileName(args.envFile, args.profile);
      const nuke = yield* NukeControl;
      const scan = yield* nuke.scan({
        entrypoint: args.main,
        profile: profileName,
        envFile: Option.getOrUndefined(args.envFile),
        mode: args.local ? "local" : "live",
        include: args.include,
        exclude: args.exclude,
        concurrency: args.concurrency,
        providerTimeoutSeconds: Duration.toSeconds(args.timeout),
      });
      for (const item of scan.failures) {
        yield* CliKit.accessors.output.warning(
          `${item.provider}: ${item.error.message}`,
        );
      }

      const predicates = args.filter.map(compileFilter);
      const targets = scan.resources.filter(
        (resource) =>
          !predicates.some((predicate) =>
            predicate({
              ...resource.attributes,
              Type: resource.providerId,
              LogicalId: resource.displayName,
            }),
          ),
      );
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
      if (
        !args.yes &&
        !(yield* CliKit.accessors.prompt.confirm({
          message: `Permanently DELETE ${targets.length} ${args.local ? "locally emulated " : ""}resource(s)? This cannot be undone.`,
          initialValue: false,
        }))
      ) {
        yield* CliKit.accessors.output.info("Aborted.");
        return yield* exitDeclined;
      }

      const operation = yield* nuke.execute({
        scanId: scan.id,
        revision: scan.revision,
        resources: targets.map(({ id }) => id),
        strategy: args.independent
          ? { _tag: "independent", retries: args.retries }
          : { _tag: "coordinated" },
        concurrency: args.concurrency,
        providerTimeoutSeconds: Duration.toSeconds(args.timeout),
      });
      const result = yield* Operation.result(operation);
      yield* CliKit.accessors.output.success(
        `Deleted ${result.deleted.length} resource(s) over ${result.passes} pass(es).`,
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
