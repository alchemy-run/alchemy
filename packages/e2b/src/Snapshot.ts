import * as crypto from "node:crypto";
import * as templates from "@distilled.cloud/e2b/templates";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { declarable } from "./internal/Declared.ts";
import { e2bName, isGeneratedName } from "./internal/Ownership.ts";
import { takeSnapshot } from "./internal/SnapshotBuild.ts";
import type { Providers } from "./Providers.ts";
import type { SandboxTemplate } from "./Sandbox.ts";

export interface SnapshotProps {
  /**
   * The `E2B.Template` (or `E2B.Snapshot`) the snapshot starts from.
   * Rebuilding it takes the snapshot again.
   */
  template: SandboxTemplate;
  /**
   * Shell commands run in order (`bash -l -c`) before the snapshot is taken:
   * clone a repository, install dependencies, warm a cache. A non-zero exit
   * fails the deploy with `SnapshotSetupFailed`.
   */
  run: string[];
  /** Environment variables for the setup commands. */
  envs?: Record<string, string>;
  /** Working directory for the setup commands. @default the sandbox user's home */
  cwd?: string;
  /**
   * Capture memory as well as the filesystem, so sandboxes resume with the
   * setup's processes still running. `false` captures the filesystem only
   * and sandboxes cold-boot from it.
   * @default true
   */
  memory?: boolean;
  /**
   * Snapshot name. If omitted, a unique name is generated from the stack,
   * stage and logical ID. Changing it replaces the snapshot.
   */
  name?: string;
  /**
   * How long the setup sandbox may run, in seconds.
   * @default 900
   */
  timeout?: number;
}

export interface SnapshotAttributes {
  /** The id sandboxes are created from, e.g. `my-team/my-snapshot:default`. */
  snapshotId: string;
  /** The snapshot's name. */
  name: string;
  /** E2B's template id for the snapshot (a snapshot is stored as a template). */
  templateId: string;
  /** Every name the snapshot answers to. */
  names: string[];
  /** Content hash of the base and setup. A deploy re-snapshots only when it changes. */
  setupHash: string;
}

export interface Snapshot extends Resource<
  "E2B.Snapshot",
  SnapshotProps,
  SnapshotAttributes,
  never,
  Providers,
  { name: string }
> {}

/**
 * A warm base to fork sandboxes from: a template booted, set up with your
 * commands, and snapshotted — memory included, so sandboxes created from it
 * start exactly where the setup left off.
 *
 * Use a snapshot for work that is too slow to repeat per sandbox and does
 * not belong in an image: cloning a repository, installing its
 * dependencies, starting a language server. A deploy re-runs the setup only
 * when the template or the commands change. E2B stores a snapshot as a
 * template, so it is created from with `E2B.CreateSandbox(snapshot)` and
 * deleted with its template.
 *
 * ### Creating a Snapshot
 * **Example:** A repository with its dependencies installed
 * ```typescript
 * export const Agent = E2B.Template("Agent", { image: "node:22-bookworm" });
 *
 * export const Warm = E2B.Snapshot("Warm", {
 *   template: Agent,
 *   run: [
 *     "git clone https://github.com/alchemy-run/alchemy /home/user/alchemy",
 *     "cd /home/user/alchemy && pnpm install",
 *   ],
 * });
 * ```
 *
 * ### Forking sandboxes from a Snapshot
 * **Example:** Every sandbox starts from the warm base
 * ```typescript
 * const sandboxes = yield* E2B.CreateSandbox(Warm);
 * const sandbox = yield* sandboxes.create({ timeout: 600 });
 * yield* sandbox.exec("cd alchemy && pnpm test");
 * ```
 *
 * ### Referencing a snapshot the stack doesn't manage
 * `E2B.Snapshot.lookup` finds an existing snapshot by name. Nothing is created,
 * adopted or deleted.
 *
 * **Example:** Look one up by name
 * ```typescript
 * const warm = E2B.Snapshot.lookup({ name: "warm-repo" });
 * const sandboxes = yield* E2B.CreateSandbox(warm);
 * ```
 *
 * @resource
 * @product Snapshot
 */
export const Snapshot = declarable<Snapshot>()(Resource<Snapshot>("E2B.Snapshot"));

const setupHashOf = (props: SnapshotProps) =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        template: props.template.templateId,
        build: props.template.buildId ?? props.template.setupHash,
        run: props.run,
        envs: props.envs,
        cwd: props.cwd,
        memory: props.memory ?? true,
      }),
    )
    .digest("hex");

/** The snapshot template, by alias. */
const observe = (name: string) =>
  templates.getTemplateByAlias({ alias: name }).pipe(
    Effect.flatMap((alias) => templates.getTemplate({ templateID: alias.templateID })),
    Effect.map((template): templates.GetTemplateResponse | undefined => template),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const SnapshotProvider = () =>
  Provider.effect(
    Snapshot,
    Effect.gen(function* () {
      return {
        stables: ["name", "templateId"],
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          const name = output?.name ?? (yield* e2bName(id, olds?.name));
          if (news.name !== undefined && news.name !== name) return { action: "replace" } as const;
          if (output !== undefined && setupHashOf(news) !== output.setupHash) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        lookup: Effect.fn(function* ({ name }) {
          const template = yield* observe(name);
          if (template === undefined) return undefined;
          return {
            snapshotId: template.names[0] ?? template.templateID,
            name,
            templateId: template.templateID,
            names: [...template.names],
            setupHash: "",
          } satisfies SnapshotAttributes;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* e2bName(id, olds?.name));
          const template = yield* observe(name);
          if (template === undefined) return undefined;
          const attrs: SnapshotAttributes = {
            snapshotId: output?.snapshotId ?? template.names[0] ?? template.templateID,
            name,
            templateId: template.templateID,
            names: [...template.names],
            setupHash: output?.setupHash ?? "",
          };
          return output !== undefined || olds?.name === undefined ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.name ?? (yield* e2bName(id, news.name));
          const setupHash = setupHashOf(news);

          // Observe — an existing ready snapshot of this exact setup is kept.
          const observed = yield* observe(name);
          if (
            observed !== undefined &&
            observed.buildStatus === "ready" &&
            output?.setupHash === setupHash
          ) {
            return { ...output, names: [...observed.names], templateId: observed.templateID };
          }

          // Ensure — snapshotting under an existing name adds a new build to
          // the same template.
          yield* session.note(`Snapshotting ${name}...`);
          const snapshot = yield* takeSnapshot(name, {
            ...news,
            template: news.template.templateId,
          });
          const template = yield* observe(name);
          return {
            snapshotId: snapshot.snapshotID,
            name,
            templateId: template?.templateID ?? snapshot.snapshotID,
            names: [...snapshot.names],
            setupHash,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* templates
            .deleteTemplate({ templateID: output.templateId })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const all = Array.from(
            yield* Stream.runCollect(templates.listTemplates.items({ limit: 100 })),
          );
          return all
            .filter((template) => template.aliases.some(isGeneratedName))
            .map((template): SnapshotAttributes => ({
              snapshotId: template.names[0] ?? template.templateID,
              name: template.aliases.find(isGeneratedName) ?? template.templateID,
              templateId: template.templateID,
              names: [...template.names],
              setupHash: "",
            }));
        }),
      };
    }),
  );
