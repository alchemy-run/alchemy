import * as DO from "@distilled.cloud/digitalocean";
import type { Toolbelt as ApiToolbelt } from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

export type ToolbeltProps = {
  /**
   * Toolbelt name, `[a-z][a-z0-9_-]{0,63}`. A change replaces the toolbelt.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Name shown in the control panel. A change replaces the toolbelt. */
  displayName?: string;
  /** Description. A change replaces the toolbelt. */
  description?: string;
  /**
   * Tools, as `<toolkit>_<tool>` slugs (for example `slack_add_bookmark`).
   * Added and removed in place; each change publishes a new version.
   */
  tools: string[];
};

export type Toolbelt = Resource<
  "DigitalOcean.ActionGateway.Toolbelt",
  ToolbeltProps,
  {
    /** Toolbelt name. */
    name: string;
    /** Current version. */
    version: string;
    /** `name@version`, for pinning a session or policy to this version. */
    reference: string;
    /** `name`, which always resolves to the latest version. */
    referenceLatest: string;
  },
  never,
  Providers
>;

export type ToolbeltAttributes = Toolbelt["Attributes"];

/**
 * An Action Gateway toolbelt: a versioned set of tools from the catalog that
 * agent sessions and policies reference as `toolbelt:<name>@<version>`.
 * Adding or removing tools publishes a new version; deleting the toolbelt
 * deprecates every version.
 *
 * ### Creating a Toolbelt
 * **Example:** Slack and GitHub tools for a support agent
 * ```typescript
 * const belt = yield* DigitalOcean.ActionGateway.Toolbelt("support", {
 *   description: "Tools the support agent may call",
 *   tools: ["slack_add_bookmark", "github_create_issue"],
 * });
 * // belt.reference → "support-…@1"
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Action-Gateway
 *
 * @resource
 * @product Action Gateway
 * @category AI
 */
export const Toolbelt = Resource<Toolbelt>("DigitalOcean.ActionGateway.Toolbelt");

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 64 });

// Observed tools carry their pinned version (`slack_add_bookmark@1`).
const slugOf = (tool: string) => tool.replace(/@[^@]*$/, "");

const toAttrs = (toolbelt: ApiToolbelt): ToolbeltAttributes => ({
  name: toolbelt.name,
  version: toolbelt.version,
  reference: toolbelt.reference,
  referenceLatest: toolbelt.reference_latest ?? toolbelt.name,
});

const observe = (name: string) =>
  noneIfNotFound(DO.getToolbelt({ name }).pipe(Effect.map((r) => r.toolbelt))).pipe(
    Effect.map((o) =>
      Option.flatMapNullishOr(o, (toolbelt) =>
        toolbelt.status === "deprecated" ? undefined : toolbelt,
      ),
    ),
  );

export const ToolbeltProvider = () =>
  Provider.succeed(Toolbelt, {
    stables: [],
    nuke: { skip: true },
    read: Effect.fn(function* ({ id, olds, output }) {
      const name = output?.name ?? olds.name ?? (yield* physicalName(id));
      const observed = yield* observe(name);
      return Option.getOrUndefined(Option.map(observed, toAttrs));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (
        news.name !== olds.name ||
        news.displayName !== olds.displayName ||
        news.description !== olds.description
      ) {
        return { action: "replace", deleteFirst: news.name !== undefined } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? output?.name ?? (yield* physicalName(id));
      const observed = yield* observe(name);
      if (Option.isNone(observed)) {
        const { toolbelt } = yield* DO.createToolbelt({
          name,
          display_name: news.displayName,
          description: news.description,
          tools: news.tools,
        });
        return toAttrs(toolbelt);
      }
      const present = (observed.value.tools ?? []).map(slugOf);
      const added = news.tools.filter((tool) => !present.includes(tool));
      const removed = present.filter((tool) => !news.tools.includes(tool));
      if (added.length > 0) yield* DO.addToolbeltTools({ name, tools: added });
      if (removed.length > 0) yield* DO.deleteToolbeltTools({ name, tools: removed });
      const final = yield* observe(name);
      return toAttrs(Option.getOrElse(final, () => observed.value));
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteToolbelt({ name: output.name }));
    }),
  });
