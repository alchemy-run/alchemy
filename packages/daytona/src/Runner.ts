import * as runners from "@distilled.cloud/daytona/runners";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { declarable } from "./internal/Declared.ts";
import { isOwnedName, resolveName } from "./internal/Names.ts";
import { resolved, type Ref } from "./internal/Ref.ts";
import type { Providers } from "./Providers.ts";

/** A region, by id. Accepts a `Daytona.Region` or `{ regionId }`. */
export type RunnerRegion = { readonly regionId: string };

export interface RunnerProps {
  /** Runner name. If omitted, generated from the stack, stage and logical ID. Changing it replaces the runner. */
  name?: string;
  /** Region the runner serves. Changing it replaces the runner. */
  region: Ref<RunnerRegion>;
  /** Tags the scheduler matches sandboxes against. Changing them replaces the runner. */
  tags?: string[];
  /** Sandbox class the runner hosts. Changing it replaces the runner. */
  sandboxClass?: runners.CreateRunnerSandboxClass;
  /** Stop scheduling new sandboxes on it. Updated in place. @default false */
  unschedulable?: boolean;
  /** Drain it: no new sandboxes, and existing ones move off. Updated in place. @default false */
  draining?: boolean;
}

export interface RunnerAttributes {
  /** Runner ID. */
  runnerId: string;
  /** Runner name. */
  name: string;
  /** Region. */
  region: string;
  /** State. */
  state: string;
  /**
   * The key the runner daemon authenticates with. Daytona shows it only at
   * creation, so alchemy keeps it in state as a `Redacted` value.
   */
  apiKey: Redacted.Redacted<string>;
}

export type Runner = Resource<"Daytona.Runner", RunnerProps, RunnerAttributes, never, Providers>;

/**
 * A runner: a machine you operate that hosts sandboxes for a custom
 * {@link Region}. Declaring it registers the runner and mints the API key
 * its daemon uses; you then start the daemon on the machine with that key.
 *
 * ### Registering a Runner
 * **Example:** A runner for a custom region
 * ```typescript
 * export const Box1 = Daytona.Runner("Box1", { region: Home });
 * ```
 *
 * @resource
 * @product Region
 */
export const Runner = declarable<Runner>()(Resource<Runner>("Daytona.Runner"));

const regionId = (region: RunnerProps["region"]) => Effect.succeed(resolved(region).regionId);

const getById = (id: string) =>
  runners.getRunner({ id }).pipe(Effect.catchTag("RunnerNotFound", () => Effect.undefined));

export const RunnerProvider = () =>
  Provider.effect(
    Runner,
    Effect.succeed({
      stables: ["runnerId", "apiKey"],
      nuke: { dependsOn: [] },
      list: Effect.fn(function* () {
        // Organizations without custom regions aren't served runners at all.
        const all = yield* runners
          .listRunners({})
          .pipe(Effect.catchTag("RunnersUnavailable", () => Effect.succeed([])));
        return all.map((r) => ({
          runnerId: r.id,
          name: r.name,
          region: r.region,
          state: r.state,
          apiKey: Redacted.make(""),
        }));
      }),
      diff: Effect.fn(function* ({ id, olds, news, output }) {
        if (!isResolved(news) || output === undefined) return undefined;
        const name = yield* resolveName(
          id,
          news.name,
          news.name === undefined ? output.name : undefined,
        );
        if (
          name !== output.name ||
          (yield* regionId(news.region)) !== output.region ||
          !deepEqual(news.tags ?? [], olds?.tags ?? []) ||
          news.sandboxClass !== olds?.sandboxClass
        ) {
          return { action: "replace", deleteFirst: name === output.name } as const;
        }
      }),
      read: Effect.fn(function* ({ id, olds, output }) {
        const name = yield* resolveName(id, olds?.name, output?.name);
        const found =
          (output ? yield* getById(output.runnerId) : undefined) ??
          (yield* runners.listRunners({})).find((r) => r.name === name);
        if (found === undefined) return undefined;
        const attrs = {
          runnerId: found.id,
          name: found.name,
          region: found.region,
          state: found.state,
          apiKey: output?.apiKey ?? Redacted.make(""),
        };
        return (yield* isOwnedName(id, found.name, output !== undefined)) ? attrs : Unowned(attrs);
      }),
      reconcile: Effect.fn(function* ({ id, news, output }) {
        const name = yield* resolveName(id, news.name, output?.name);
        const region = yield* regionId(news.region);
        // Observe
        let current = output ? yield* getById(output.runnerId) : undefined;
        let apiKey = output?.apiKey;
        // Ensure
        if (current === undefined) {
          const created = yield* runners.createRunner({
            regionId: region,
            name,
            tags: news.tags,
            sandboxClass: news.sandboxClass,
          });
          apiKey = Redacted.isRedacted(created.apiKey)
            ? created.apiKey
            : Redacted.make(created.apiKey);
          current = yield* runners.getRunner({ id: created.id });
        }
        // Sync scheduling flags.
        if ((news.unschedulable ?? false) !== current.unschedulable) {
          current = yield* runners.updateRunnerScheduling({
            id: current.id,
            unschedulable: news.unschedulable ?? false,
          });
        }
        if ((news.draining ?? false) !== (current.draining ?? false)) {
          current = yield* runners.updateRunnerDraining({
            id: current.id,
            draining: news.draining ?? false,
          });
        }
        return {
          runnerId: current.id,
          name: current.name,
          region: current.region,
          state: current.state,
          apiKey: apiKey ?? Redacted.make(""),
        };
      }),
      delete: Effect.fn(function* ({ output }) {
        yield* runners
          .deleteRunner({ id: output.runnerId })
          .pipe(Effect.catchTag("RunnerNotFound", () => Effect.void));
      }),
    }),
  );
