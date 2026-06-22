import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { MinimumLogLevel } from "effect/References";
import { Command, Flag } from "effect/unstable/cli";
import picomatch from "picomatch";

import { AuthProviders } from "../../Auth/AuthProvider.ts";
import { withProfileOverride } from "../../Auth/Profile.ts";
import type { ProviderService } from "../../Provider.ts";
import { Stack } from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import * as Clank from "../../Util/Clank.ts";
import { loadConfigProvider } from "../../Util/ConfigProvider.ts";
import { fileLogger } from "../../Util/FileLogger.ts";
import type { ScopedPlanStatusSession } from "../Cli.ts";
import { isNonInteractive } from "../selectCli.ts";
import * as NukeUI from "../tui/components/Nuke.tsx";

import {
  dryRun,
  envFile,
  importStack,
  instrumentCommand,
  profile,
  script,
  yes,
} from "./_shared.ts";

const includeFlag = Flag.string("include").pipe(
  Flag.withDescription(
    "Glob of provider IDs to include (e.g. 'Cloudflare.*' or 'Cloudflare.Worker'). " +
      "Repeatable; when omitted, every provider is included.",
  ),
  Flag.atLeast(0),
);

const excludeFlag = Flag.string("exclude").pipe(
  Flag.withDescription(
    "Glob of provider IDs to exclude (applied after --include). Repeatable.",
  ),
  Flag.atLeast(0),
);

const filterFlag = Flag.string("filter").pipe(
  Flag.withDescription(
    "JavaScript expression evaluated with `resource` in scope " +
      '(e.g. \'resource.Type === "Cloudflare.Worker" && ' +
      'resource.workerName.startsWith("alchemy-")\'). Any resource for which ' +
      "an expression is truthy is SPARED. Repeatable.",
  ),
  Flag.atLeast(0),
);

const verboseFlag = Flag.boolean("verbose").pipe(
  Flag.withAlias("v"),
  Flag.withDescription(
    "List every individual resource that will be deleted, not just per-provider counts.",
  ),
  Flag.withDefault(false),
);

const concurrencyFlag = Flag.integer("concurrency").pipe(
  Flag.withDescription(
    "Max number of providers scanned/deleted in parallel (resources within a " +
      "provider are always deleted concurrently). Use 0 for unbounded. " +
      "Default: 16 — unbounded tends to be slower because it triggers " +
      "provider-side rate limiting and retry backoff.",
  ),
  Flag.withDefault(16),
  Flag.map((n): number | "unbounded" => (n <= 0 ? "unbounded" : n)),
);

const timeoutFlag = Flag.integer("timeout").pipe(
  Flag.withDescription(
    "Per-provider timeout (seconds) for each list/delete call, so one slow or " +
      "hanging provider can't stall the whole run. Default: 120.",
  ),
  Flag.withDefault(120),
);

interface DiscoveredProvider {
  id: string;
  provider: ProviderService;
}

const isProviderCollection = (
  value: unknown,
): value is { providers: Record<string, ProviderService | undefined> } =>
  typeof value === "object" &&
  value !== null &&
  (value as { kind?: unknown }).kind === "ProviderCollection";

const hasListAndDelete = (value: unknown): value is ProviderService =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ProviderService).list === "function" &&
  typeof (value as ProviderService).delete === "function";

/**
 * Walk the built provider context and extract every resource provider keyed
 * by its provider ID (e.g. `"Cloudflare.Worker"`). Providers live inside a
 * {@link ProviderCollectionService}; we also pick up any directly-registered
 * provider whose key looks like a resource type. Only providers exposing a
 * `list` method are returned — policies and bindings are skipped.
 */
const discoverProviders = (
  context: Context.Context<never>,
): DiscoveredProvider[] => {
  // Resources opted out of teardown (`nuke.singleton` settings whose delete
  // only resets, or `nuke.skip` resources that can never be deleted) would be
  // re-enumerated and "re-deleted" every run — skip them.
  const isNukeable = (p: ProviderService) =>
    !p.nuke?.singleton && !p.nuke?.skip;
  const out = new Map<string, ProviderService>();
  for (const [key, value] of context.mapUnsafe.entries()) {
    if (isProviderCollection(value)) {
      for (const [id, provider] of Object.entries(value.providers)) {
        if (
          provider &&
          typeof provider.list === "function" &&
          isNukeable(provider)
        ) {
          out.set(id, provider);
        }
      }
    } else if (
      typeof key === "string" &&
      key.includes(".") &&
      hasListAndDelete(value) &&
      isNukeable(value)
    ) {
      out.set(key, value);
    }
  }
  return [...out.entries()]
    .map(([id, provider]) => ({ id, provider }))
    .sort((a, b) => a.id.localeCompare(b.id));
};

/**
 * Compile a `--filter` expression into a predicate. The expression is
 * evaluated with `{ resource }` placed on the scope chain via `with`, so it
 * can reference `resource.Type`, `resource.LogicalId`, and any attribute
 * directly. A throwing or non-boolean expression is treated as `false`.
 */
const compileFilter = (
  expr: string,
): ((resource: Record<string, unknown>) => boolean) => {
  // `new Function` bodies are sloppy-mode, so `with` is permitted here even
  // though this module is ESM/strict.
  const fn = new Function(
    "scope",
    `with (scope) { return (${expr}); }`,
  ) as (scope: { resource: Record<string, unknown> }) => unknown;
  return (resource) => {
    try {
      return Boolean(fn({ resource }));
    } catch {
      return false;
    }
  };
};

/**
 * High-signal identifier attributes, most human-friendly first. These are the
 * explicit per-resource identifier keys observed across the AWS / Cloudflare /
 * Planetscale / Neon / GitHub providers (e.g. `Worker.workerName`,
 * `Function.functionName`, `Table.tableName`, `Zone.name`, `Route.pattern`).
 * The generic suffix passes in {@link displayName} cover everything else.
 */
const PRIMARY_NAME_KEYS = [
  "workerName",
  "functionName",
  "bucketName",
  "tableName",
  "queueName",
  "streamName",
  "topicName",
  "roleName",
  "userName",
  "groupName",
  "clusterName",
  "serviceName",
  "repositoryName",
  "databaseName",
  "branchName",
  "projectName",
  "tunnelName",
  "secretName",
  "storeName",
  "scriptName",
  "workflowName",
  "loadBalancerName",
  "indexName",
  "applicationName",
  "fullName",
  "domainName",
  "hostname",
  "dnsName",
  "pattern",
  "displayName",
  "friendlyName",
  "commonName",
  "slug",
  "name",
];

/**
 * Generic identifiers shared by many resources that make poor display labels.
 * Only used as a last resort, after suffix-based matching.
 */
const WEAK_KEYS = ["accountId", "zoneId"];

const stringAttr = (
  attr: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = attr[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

/** First non-weak string attribute whose key ends with one of `suffixes`. */
const findBySuffix = (
  attr: Record<string, unknown>,
  suffixes: string[],
): string | undefined => {
  for (const key of Object.keys(attr)) {
    if (WEAK_KEYS.includes(key)) continue;
    if (suffixes.some((s) => key.endsWith(s))) {
      const value = stringAttr(attr, key);
      if (value) return value;
    }
  }
  return undefined;
};

/**
 * Best-effort human-readable identifier for a discovered resource. Tries, in
 * order: an explicit high-signal key ({@link PRIMARY_NAME_KEYS}), then any
 * `*Name`, `*Arn`, `*Url`/endpoint/host, or `*Id` attribute, then a weak
 * generic id, then any string value.
 */
const displayName = (attr: Record<string, unknown>): string =>
  PRIMARY_NAME_KEYS.map((key) => stringAttr(attr, key)).find(Boolean) ??
  findBySuffix(attr, ["Name", "name"]) ??
  findBySuffix(attr, ["Arn", "arn"]) ??
  findBySuffix(attr, ["Url", "url"]) ??
  stringAttr(attr, "endpoint") ??
  stringAttr(attr, "host") ??
  findBySuffix(attr, ["Id", "id"]) ??
  WEAK_KEYS.map((key) => stringAttr(attr, key)).find(Boolean) ??
  Object.values(attr).find(
    (value): value is string => typeof value === "string" && value.length > 0,
  ) ??
  "";

const groupBy = <T>(items: T[], key: (item: T) => string): Map<string, T[]> => {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
};

const nukeSession: ScopedPlanStatusSession = {
  emit: () => Effect.void,
  done: () => Effect.void,
  note: () => Effect.void,
};
const nukeCommand = Command.make(
  "nuke",
  {
    main: script,
    envFile,
    profile,
    yes,
    dryRun,
    verbose: verboseFlag,
    concurrency: concurrencyFlag,
    timeout: timeoutFlag,
    include: includeFlag,
    exclude: excludeFlag,
    filter: filterFlag,
  },
  instrumentCommand("unsafe.nuke", (a: { profile: string; main: string }) => ({
    "alchemy.profile": a.profile,
    "alchemy.main": a.main,
  }))(
    Effect.fnUntraced(function* ({
      main,
      envFile,
      profile,
      yes,
      dryRun,
      verbose,
      concurrency,
      timeout,
      include,
      exclude,
      filter,
    }) {
      // DEBUG=1 routes provider logs to the console (instead of the
      // .alchemy/log/out file) at Debug level and disables the TUI so the
      // log stream isn't clobbered by the progress renderer.
      const debug = !!process.env.DEBUG;
      const interactive = !isNonInteractive() && !debug;
      const stackEffect = yield* importStack(main);
      const authProviders: AuthProviders["Service"] = {};

      // Build the state + providers layer (same wiring as `alchemy login`) so
      // that the resulting context holds every resource provider plus the
      // cloud-environment services their `list`/`delete` need at call time.
      const context = yield* Layer.build(
        (stackEffect.providers ?? Layer.empty).pipe(
          Layer.provideMerge(stackEffect.state ?? Layer.empty),
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(AuthProviders, authProviders),
              ConfigProvider.layer(
                withProfileOverride(
                  yield* loadConfigProvider(envFile),
                  profile,
                ),
              ),
              debug
                ? Logger.layer([Logger.defaultLogger])
                : Logger.layer([fileLogger("out")], {
                    mergeWithExisting: true,
                  }),
              Layer.succeed(MinimumLogLevel, debug ? "Debug" : "Info"),
              Layer.succeed(Stage, "placeholder"),
              Layer.succeed(Stack, {
                actions: {},
                bindings: {},
                name: stackEffect.stackName,
                resources: {},
                stage: "placeholder",
              }),
            ),
          ),
        ),
      );

      const discovered = discoverProviders(context as Context.Context<never>);

      const matchInclude =
        include.length > 0 ? picomatch([...include]) : () => true;
      const matchExclude =
        exclude.length > 0 ? picomatch([...exclude]) : () => false;
      const selected = discovered.filter(
        (p) => matchInclude(p.id) && !matchExclude(p.id),
      );

      if (selected.length === 0) {
        yield* Console.log("No providers match the given --include/--exclude.");
        return;
      }

      // Predicates that SPARE a matching resource from deletion. Applied
      // during the scan so the live counts reflect the filter rather than
      // the raw discovered total.
      const predicates = filter.map(compileFilter);
      const isSpared = (attr: Record<string, unknown>, id: string) =>
        predicates.some((p) =>
          p({ ...attr, Type: id, LogicalId: displayName(attr) }),
        );

      // ---- Scan phase --------------------------------------------------
      const scanUI = interactive
        ? yield* Effect.sync(() => NukeUI.renderScan(selected.length))
        : undefined;
      const emitScan = (event: NukeUI.ScanEvent) =>
        scanUI ? Effect.sync(() => scanUI.emit(event)) : Effect.void;

      const listed = yield* Effect.all(
        selected.map(({ id, provider }) =>
          Effect.gen(function* () {
            yield* emitScan({ kind: "start", id });
            const attrs = yield* provider.list().pipe(
              Effect.timeout(`${timeout} seconds`),
              // Log inside the provided scope so the failure lands in the
              // stack's file logger (.alchemy/log/out), then swallow it so a
              // single broken/slow provider doesn't abort the whole scan.
              Effect.tapCause((cause) =>
                Effect.logWarning(`nuke: scan failed for ${id}`, cause),
              ),
              Effect.provide(context),
              Effect.matchCause({
                onSuccess: (attrs: unknown[]) => attrs,
                onFailure: () => [] as unknown[],
              }),
            );
            const items = attrs.map((raw) => {
              const attr = (raw ?? {}) as Record<string, unknown>;
              return {
                attr,
                name: displayName(attr),
                spared: isSpared(attr, id),
              };
            });
            yield* emitScan({
              kind: "done",
              id,
              count: items.filter((i) => !i.spared).length,
            });
            return { id, provider, items };
          }),
        ),
        { concurrency },
      );

      if (scanUI) {
        yield* Effect.sleep(10);
        yield* Effect.sync(() => scanUI.unmount());
      }

      // ---- Filter phase ------------------------------------------------
      const candidates = listed.flatMap(({ id, provider, items }) =>
        items.map(({ attr, name, spared }) => ({
          id,
          provider,
          attr,
          name,
          spared,
        })),
      );

      const targets = candidates.filter((c) => !c.spared);
      const filteredTotal = candidates.length - targets.length;

      // ---- Report ------------------------------------------------------
      // One line per provider type with its to-delete count and how many were
      // filtered out by --filter. With --verbose, also enumerate each
      // individual resource that will be deleted.
      const byType = [...groupBy(candidates, (c) => c.id).entries()].sort(
        (a, b) => a[0].localeCompare(b[0]),
      );
      yield* Console.log("");
      yield* Effect.forEach(
        byType,
        ([id, items]) =>
          Effect.gen(function* () {
            const toDelete = items.filter((c) => !c.spared);
            const filtered = items.length - toDelete.length;
            yield* Console.log(
              `${id}  ${toDelete.length} to delete` +
                (filtered > 0 ? ` (${filtered} filtered out)` : ""),
            );
            if (verbose) {
              yield* Effect.forEach(
                toDelete,
                (c) => Console.log(`  - ${c.name}`),
                { discard: true },
              );
            }
          }),
        { discard: true },
      );

      yield* Console.log("");
      yield* Console.log(
        filteredTotal > 0
          ? `${targets.length} resource(s) to delete (${filteredTotal} filtered out).`
          : `${targets.length} resource(s) to delete.`,
      );

      if (targets.length === 0) {
        yield* Console.log("Nothing to delete.");
        return;
      }

      if (dryRun) {
        yield* Console.log(
          "Dry run: nothing was deleted. Re-run without --dry-run to delete.",
        );
        return;
      }

      // ---- Confirm -----------------------------------------------------
      const approved = yes
        ? true
        : yield* Clank.confirm({
            message:
              `Permanently DELETE ${targets.length} resource(s)? ` +
              `This cannot be undone.`,
            initialValue: false,
          });
      if (!approved) {
        yield* Console.log("Aborted.");
        return;
      }

      // ---- Delete phase ------------------------------------------------
      const totals = [...groupBy(targets, (t) => t.id).entries()].map(
        ([id, items]) => ({ id, total: items.length }),
      );
      const deleteUI = interactive
        ? yield* Effect.sync(() => NukeUI.renderDelete(totals))
        : undefined;
      const emitDelete = (event: NukeUI.DeleteEvent) =>
        deleteUI ? Effect.sync(() => deleteUI.emit(event)) : Effect.void;

      let remaining = targets;
      let pass = 0;
      while (remaining.length > 0) {
        pass += 1;
        yield* emitDelete({ kind: "pass", pass });

        const byType = groupBy(remaining, (t) => t.id);
        const results = yield* Effect.all(
          [...byType.values()].map((items) =>
            Effect.all(
              items.map((item) =>
                item.provider
                  .delete({
                    id: displayName(item.attr),
                    instanceId: "",
                    olds: item.attr as never,
                    output: item.attr as never,
                    session: nukeSession,
                    bindings: [],
                  })
                  .pipe(
                    Effect.timeout(`${timeout} seconds`),
                    Effect.tapCause((cause) =>
                      Effect.logWarning(
                        `nuke: delete failed for ${item.id} ${displayName(item.attr)}`,
                        cause,
                      ),
                    ),
                    Effect.provide(context),
                    Effect.matchCause({
                      onSuccess: () => ({ item, ok: true as const }),
                      onFailure: () => ({ item, ok: false as const }),
                    }),
                    Effect.tap((r) =>
                      r.ok
                        ? emitDelete({ kind: "deleted", id: item.id })
                        : emitDelete({ kind: "failed", id: item.id }),
                    ),
                  ),
              ),
              { concurrency: "unbounded" },
            ),
          ),
          { concurrency },
        );

        const failed = results.flat().flatMap((r) => (r.ok ? [] : [r.item]));
        // No resource deleted this pass: dependencies can't resolve further,
        // so stop instead of looping forever.
        if (failed.length === remaining.length) {
          remaining = failed;
          break;
        }
        remaining = failed;
      }

      if (deleteUI) {
        yield* Effect.sleep(10);
        yield* Effect.sync(() => deleteUI.unmount());
      }

      const deleted = targets.length - remaining.length;
      yield* Console.log("");
      yield* Console.log(
        `Deleted ${deleted} resource(s) over ${pass} pass(es).`,
      );
      if (remaining.length > 0) {
        yield* Console.log(
          `${remaining.length} resource(s) could not be deleted.`,
        );
      }
    }),
  ),
).pipe(
  // hide the command because it's dangerous and we don't want agents to discover and use it
  Command.withHidden,
  Command.withDescription(
    "Enumerate every live resource across the stack's providers and delete " +
      "them. DESTRUCTIVE — use --include/--exclude/--filter to scope it.",
  ),
);

export const unsafeCommand = Command.make("unsafe", {}).pipe(
  Command.withDescription("Dangerous, irreversible operations."),
  Command.withSubcommands([nukeCommand]),
);
