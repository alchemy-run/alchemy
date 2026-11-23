import * as lambdacore from "@distilled.cloud/aws/lambda-core";
import { isResolved } from "alchemy/Diff";
import type { Input } from "alchemy/Input";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { ScopedPlanStatusSession } from "alchemy/Report";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { Providers } from "../Providers.ts";
import type { RuntimeReleaseLifecycle } from "./Runtime.ts";
import {
  fromLifecycle,
  lifecycleEqual,
  recoveryWindowOf,
  toLifecycle,
} from "./RuntimeLifecycle.ts";
import type { RuntimeVersion } from "./RuntimeVersion.ts";

export interface RuntimeAliasProps {
  /** The runtime version the alias points to. Changing it rolls the update out. */
  version: RuntimeVersion;
  /**
   * The alias name consumers reference, such as `prod`: letters, numbers,
   * `-`, `_` and `.`, up to 128 characters. If omitted, a unique name is
   * generated. Changing it replaces the alias.
   */
  name?: string;
  /** What the alias is for, shown to consumers. */
  description?: string;
  /**
   * Deprecation dates for the alias. Omit to inherit the runtime's.
   */
  releaseLifecycle?: RuntimeReleaseLifecycle;
  /**
   * Days (7–30) Lambda keeps the alias restorable after Alchemy deletes it.
   * Functions on a deleted alias fail on their next cold start.
   * @default 30
   */
  recoveryWindowInDays?: number;
}

export interface RuntimeAlias extends Resource<
  "AWS.Lambda.RuntimeAlias",
  RuntimeAliasProps,
  {
    /** The alias ARN. */
    aliasArn: string;
    /** The alias name, which functions reference. */
    aliasName: string;
    /** The ARN of the runtime the alias belongs to, which functions reference. */
    runtimeArn: string;
    /** The name of the runtime the alias belongs to. */
    runtimeName: string;
    /** The name of the version the alias points to. */
    versionName: string;
    /** The ARN of the version the alias points to. */
    versionArn: string;
    /** The architectures functions on the alias may use. */
    architectures: string[];
    /** The alias state, e.g. `ACTIVE`. */
    state: string;
    /** The alias description. */
    description?: string;
    /** The alias's own deprecation dates, or the runtime's. */
    releaseLifecycle?: RuntimeReleaseLifecycle;
  },
  never,
  Providers,
  RuntimeAliasLookup
> {}

/**
 * Props for {@link RuntimeAlias.lookup}: find an alias this stack doesn't
 * manage, such as one a platform team shares from another account.
 */
export interface RuntimeAliasLookup {
  /** The runtime's name or ARN. A runtime in another account needs its ARN. */
  runtime: string;
  /** The alias name, e.g. `prod`. */
  name: string;
}

/**
 * A named pointer to a {@link RuntimeVersion}. Functions run on an alias, so
 * pointing it at a new version rolls that version out to every function on
 * it at their next cold start, without redeploying them. Point it back to
 * roll back.
 *
 * ### Rolling out a runtime
 * **Example:** Point `prod` at a version
 * ```typescript
 * const prod = yield* AWS.Lambda.RuntimeAlias("NodeProd", {
 *   version: v1,
 *   name: "prod",
 *   description: "Production Node.js runtime",
 * });
 * ```
 *
 * **Example:** Run a function on the alias
 * ```typescript
 * const api = yield* AWS.Lambda.Function("Api", {
 *   main: import.meta.url,
 *   runtime: prod,
 * });
 * ```
 *
 * ### Using a shared runtime
 * `RuntimeAlias.lookup` references an alias Alchemy doesn't manage, such as
 * one shared from a platform team's account. It is read during plan and
 * deploy and never created, updated or deleted.
 *
 * **Example:** Run a function on another account's runtime
 * ```typescript
 * const prod = AWS.Lambda.RuntimeAlias.lookup({
 *   runtime: "arn:aws:lambda:us-east-1:123456789012:runtime/companynode",
 *   name: "prod",
 * });
 * const api = yield* AWS.Lambda.Function("Api", {
 *   main: import.meta.url,
 *   runtime: prod,
 * });
 * ```
 *
 * @resource
 */
export const RuntimeAlias = Resource<RuntimeAlias>("AWS.Lambda.RuntimeAlias");

export class RuntimeAliasFailed extends Data.TaggedError("RuntimeAliasFailed")<{
  readonly message: string;
}> {}

class RuntimeAliasPending extends Data.TaggedError("RuntimeAliasPending")<{
  readonly state: string;
}> {}

type ResolvedProps = Input.ResolveProps<RuntimeAliasProps>;
const resolved = (props: RuntimeAliasProps) => props as unknown as ResolvedProps;

const resolveAliasName = (id: string, name: string | undefined) =>
  name ? Effect.succeed(name) : createPhysicalName({ id, maxLength: 128, delimiter: "-" });

const getAlias = (runtime: string, name: string) =>
  lambdacore
    .getRuntimeAlias({ RuntimeName: runtime, Name: name })
    .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));

const toAttrs = (
  alias: lambdacore.GetRuntimeAliasResponse,
  runtime: { runtimeArn: string; runtimeName: string },
): RuntimeAlias["Attributes"] => ({
  aliasArn: alias.Arn,
  aliasName: alias.Name,
  runtimeArn: runtime.runtimeArn,
  runtimeName: runtime.runtimeName,
  versionName: alias.RuntimeVersion,
  versionArn: alias.RuntimeVersionArn,
  architectures: [...(alias.Compatibility?.Architectures ?? [])],
  state: alias.State,
  description: alias.Description || undefined,
  releaseLifecycle: fromLifecycle(alias.ReleaseLifecycle),
});

const waitForActive = (runtime: string, name: string, session: ScopedPlanStatusSession) =>
  Effect.gen(function* () {
    const alias = yield* lambdacore.getRuntimeAlias({ RuntimeName: runtime, Name: name });
    if (alias.State === "ACTIVE") return alias;
    if (alias.State === "CREATING" || alias.State === "UPDATING") {
      return yield* new RuntimeAliasPending({ state: alias.State });
    }
    return yield* new RuntimeAliasFailed({ message: `Runtime alias ${name} is ${alias.State}.` });
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "RuntimeAliasPending",
      schedule: Schedule.spaced("2 seconds").pipe(
        Schedule.tap(() => session.note(`Waiting for runtime alias ${name}...`)),
      ),
      times: 30,
    }),
  );

export const RuntimeAliasProvider = () =>
  Provider.succeed(RuntimeAlias, {
    stables: ["aliasArn", "aliasName", "runtimeArn", "runtimeName"],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return;
      const n = resolved(news);
      if (n.version === undefined) return;
      if (
        n.version.runtimeArn !== output.runtimeArn ||
        (n.name ?? output.aliasName) !== output.aliasName
      ) {
        return { action: "replace" } as const;
      }
    }),

    lookup: Effect.fn(function* ({ runtime, name }) {
      const alias = yield* getAlias(runtime, name);
      if (alias === undefined) return undefined;
      const parent = yield* lambdacore.getRuntime({ RuntimeName: runtime });
      return toAttrs(alias, { runtimeArn: parent.Arn, runtimeName: parent.Name });
    }),

    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const alias = yield* getAlias(output.runtimeArn, output.aliasName);
      if (alias === undefined || alias.State === "PENDING_DELETION") return undefined;
      return toAttrs(alias, output);
    }),

    list: () =>
      lambdacore.listRuntimes.items({}).pipe(
        Stream.filter((runtime) => runtime.State !== "PENDING_DELETION"),
        Stream.flatMap(
          (runtime) =>
            lambdacore.listRuntimeAliases.items({ RuntimeName: runtime.Arn }).pipe(
              Stream.filter((alias) => alias.State !== "PENDING_DELETION"),
              Stream.mapEffect((summary) => getAlias(runtime.Arn, summary.Name)),
              Stream.flatMap((alias) =>
                alias === undefined
                  ? Stream.empty
                  : Stream.make(
                      toAttrs(alias, { runtimeArn: runtime.Arn, runtimeName: runtime.Name }),
                    ),
              ),
            ),
          { concurrency: 5 },
        ),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      ),

    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const n = resolved(news);
      const runtime = {
        runtimeArn: n.version.runtimeArn,
        runtimeName: n.version.runtimeName,
      };
      const name = output?.aliasName ?? (yield* resolveAliasName(id, n.name));
      const desiredLifecycle = fromLifecycle(toLifecycle(n.releaseLifecycle));

      // Observe. An alias pending deletion keeps its name reserved, so
      // restore it; the sync below points it at the desired version.
      let alias = yield* getAlias(runtime.runtimeArn, name);
      // Lambda restores an alias only while its version is live, so a
      // version that was deleted with it is restored first and scheduled
      // for deletion again once the alias has moved off it.
      let staleVersion: string | undefined;
      if (alias?.State === "PENDING_DELETION") {
        const pointedAt = yield* lambdacore
          .getRuntimeVersion({ RuntimeName: runtime.runtimeArn, Name: alias.RuntimeVersion })
          .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));
        if (pointedAt?.State === "PENDING_DELETION") {
          yield* lambdacore.restoreRuntime({
            RuntimeName: runtime.runtimeArn,
            RuntimeVersion: alias.RuntimeVersion,
          });
          if (alias.RuntimeVersion !== n.version.versionName) {
            staleVersion = alias.RuntimeVersion;
          }
        }
        yield* session.note(`Restoring runtime alias ${name} from pending deletion...`);
        yield* lambdacore.restoreRuntime({
          RuntimeName: runtime.runtimeArn,
          RuntimeAlias: name,
        });
        alias = yield* waitForActive(runtime.runtimeArn, name, session);
      }

      // Ensure.
      if (alias === undefined) {
        yield* session.note(`Creating runtime alias ${name} -> ${n.version.versionName}...`);
        yield* lambdacore
          .createRuntimeAlias({
            RuntimeName: runtime.runtimeArn,
            Name: name,
            RuntimeVersion: n.version.versionName,
            Description: n.description,
            ReleaseLifecycle: toLifecycle(n.releaseLifecycle),
          })
          .pipe(Effect.catchTag("ResourceConflictException", () => Effect.void));
      }
      alias = yield* waitForActive(runtime.runtimeArn, name, session);

      // Sync the version, description and lifecycle. Lifecycle is compared
      // only when set: an alias without its own reports the runtime's.
      if (
        alias.RuntimeVersion !== n.version.versionName ||
        (alias.Description || undefined) !== n.description ||
        (desiredLifecycle !== undefined &&
          !lifecycleEqual(fromLifecycle(alias.ReleaseLifecycle), desiredLifecycle))
      ) {
        yield* session.note(`Pointing runtime alias ${name} at ${n.version.versionName}...`);
        yield* lambdacore
          .updateRuntimeAlias({
            RuntimeName: runtime.runtimeArn,
            Name: name,
            RuntimeVersion: n.version.versionName,
            Description: n.description ?? "",
            ReleaseLifecycle: toLifecycle(n.releaseLifecycle),
          })
          .pipe(
            Effect.retry({
              while: (e) => e._tag === "ResourceConflictException",
              schedule: Schedule.spaced("2 seconds"),
              times: 10,
            }),
          );
        alias = yield* waitForActive(runtime.runtimeArn, name, session);
      }

      if (staleVersion !== undefined) {
        yield* lambdacore
          .deleteRuntimeVersion({
            RuntimeName: runtime.runtimeArn,
            Name: staleVersion,
            RecoveryWindowInDays: 7,
          })
          .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
      }

      return toAttrs(alias, runtime);
    }),

    delete: Effect.fn(function* ({ olds, output, session, force }) {
      yield* session.note(`Scheduling runtime alias ${output.aliasName} for deletion...`);
      yield* lambdacore
        .deleteRuntimeAlias({
          RuntimeName: output.runtimeArn,
          Name: output.aliasName,
          RecoveryWindowInDays: recoveryWindowOf(olds.recoveryWindowInDays, force),
        })
        .pipe(
          Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          Effect.retry({
            while: (e) => e._tag === "ResourceConflictException",
            schedule: Schedule.spaced("2 seconds"),
            times: 10,
          }),
        );
    }),
  });
