import * as DO from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

export type OutputViewProps = {
  /**
   * The tool, as a provider-qualified slug (`exa_web_search`), optionally
   * pinned (`exa_web_search@v14`). Unpinned binds the version the catalog
   * releases now. A change replaces the view.
   */
  tool: string;
  /**
   * Output paths to keep, dotted (`results.title`), 1 to 64 of them, each
   * declared by the tool's output schema. A change replaces the view.
   */
  fields: string[];
  /**
   * View name, unique per tool version. A change replaces the view.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Description. A change replaces the view. */
  description?: string;
};

export type OutputView = Resource<
  "DigitalOcean.ActionGateway.OutputView",
  OutputViewProps,
  {
    /** View ID (`ov_…`). */
    viewId: string;
    /** View name. */
    name: string;
    /** The tool version the view is bound to, like `v14`. */
    toolVersion: string;
    /** The JSON Schema every result through the view satisfies. */
    outputSchema: unknown;
  },
  never,
  Providers
>;

export type OutputViewAttributes = OutputView["Attributes"];

/**
 * A named projection of one tool's output: calls through it return only the
 * listed fields, which keeps an agent's context small. Use its name in an
 * {@link Endpoint}'s `outputViews`.
 *
 * ### Projecting a Tool's Output
 * **Example:** Keep only search result titles and URLs
 * ```typescript
 * const view = yield* DigitalOcean.ActionGateway.OutputView("Titles", {
 *   tool: "exa_web_search",
 *   fields: ["results.title", "results.url"],
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Action-Gateway
 *
 * @resource
 * @product Action Gateway
 * @category AI
 */
export const OutputView = Resource<OutputView>("DigitalOcean.ActionGateway.OutputView");

// `^[a-z][a-z0-9_-]{0,63}$`
const physicalName = (id: string) =>
  createPhysicalName({ id, lowercase: true, maxLength: 64, delimiter: "-" });

const observe = (viewId: string) =>
  noneIfNotFound(DO.getOutputView({ view_id: viewId }).pipe(Effect.map((r) => r.view))).pipe(
    Effect.map((view) => Option.filter(view, (v): v is DO.OutputView => v?.view_id === viewId)),
  );

const toAttrs = (view: DO.OutputView): OutputViewAttributes => ({
  viewId: view.view_id ?? "",
  name: view.name ?? "",
  toolVersion: view.version ?? "",
  outputSchema: view.output_schema,
});

const sameList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export const OutputViewProvider = () =>
  Provider.succeed(OutputView, {
    stables: ["viewId", "name", "toolVersion"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const observed = yield* observe(output.viewId);
      return Option.getOrUndefined(Option.map(observed, toAttrs));
    }),
    // The API has no update: every change is a new view.
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (
        news.tool !== olds.tool ||
        !sameList(news.fields, olds.fields) ||
        (news.name !== undefined && news.name !== olds.name) ||
        news.description !== olds.description
      ) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const observed = output === undefined ? Option.none() : yield* observe(output.viewId);
      if (Option.isSome(observed)) return toAttrs(observed.value);
      const name = news.name ?? output?.name ?? (yield* physicalName(id));
      const created = yield* DO.createOutputView({
        tool: news.tool,
        name,
        description: news.description,
        fields: news.fields,
      });
      return toAttrs(created.view ?? {});
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteOutputView({ view_id: output.viewId }));
    }),
  });
