import * as DO from "@distilled.cloud/digitalocean";
import type { ApiModelRouter } from "@distilled.cloud/digitalocean";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import type { Providers } from "../Providers.ts";

export type ModelRouterProps = {
  /**
   * Router name; agents and inference calls address it as `router:<name>`.
   * Updates in place.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Description. Updates in place. */
  description?: string;
  /** Per-task routing policies, passed through. Updates in place. */
  policies?: DO.ApiModelRouterTaskPolicy[];
  /** Models to fall back to, by inference name. Updates in place. */
  fallbackModels?: string[];
};

export type ModelRouter = Resource<
  "DigitalOcean.GenAI.ModelRouter",
  ModelRouterProps,
  {
    /** Router UUID. */
    modelRouterId: string;
    /** Router name. */
    name: string;
  },
  never,
  Providers
>;

export type ModelRouterAttributes = ModelRouter["Attributes"];

/**
 * A model router: picks a model per request by task, with fallbacks. Every
 * field updates in place.
 *
 * ### Routing by Task
 * **Example:** Fall back to a small model
 * ```typescript
 * yield* DigitalOcean.GenAI.ModelRouter("chat", {
 *   description: "Chat with a cheap fallback",
 *   fallbackModels: ["mistral-3-14B"],
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/GenAI-Platform
 *
 * @resource
 * @product GenAI Platform
 * @category AI
 */
export const ModelRouter = Resource<ModelRouter>("DigitalOcean.GenAI.ModelRouter");

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const observe = (uuid: string) =>
  noneIfNotFound(DO.getGenaiModelRouter({ uuid }).pipe(Effect.map((r) => r.model_router)));

export const ModelRouterProvider = () =>
  Provider.succeed(ModelRouter, {
    stables: ["modelRouterId"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const observed = yield* observe(output.modelRouterId);
      return Option.isSome(observed) ? output : undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const name = news.name ?? output?.name ?? (yield* physicalName(id));
      const body = {
        name,
        description: news.description,
        policies: news.policies,
        fallback_models: news.fallbackModels,
      };
      const observed =
        output === undefined ? Option.none<ApiModelRouter>() : yield* observe(output.modelRouterId);
      if (Option.isNone(observed)) {
        const { model_router } = yield* DO.createGenaiModelRouter(body);
        return { modelRouterId: model_router.uuid, name };
      }
      const same =
        observed.value.name === name &&
        (news.description === undefined || observed.value.description === news.description) &&
        olds !== undefined &&
        JSON.stringify(olds.policies ?? []) === JSON.stringify(news.policies ?? []) &&
        JSON.stringify(olds.fallbackModels ?? []) === JSON.stringify(news.fallbackModels ?? []);
      if (!same) yield* DO.updateGenaiModelRouter({ uuid: observed.value.uuid, ...body });
      return { modelRouterId: observed.value.uuid, name };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteGenaiModelRouter({ uuid: output.modelRouterId }));
    }),
  });
