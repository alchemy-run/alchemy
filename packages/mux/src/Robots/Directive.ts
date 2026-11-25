import * as MuxRetry from "@distilled.cloud/mux/Retry";
import * as Robots from "@distilled.cloud/mux/robots";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { Providers } from "../Providers.ts";

export interface DirectiveProps {
  /** Human-readable name, 1 to 256 characters. */
  name: string;
  /**
   * What the Directive runs on. Only `video.asset` exists.
   * @default { type: "video.asset" }
   */
  subject?: Robots.DirectiveSubject;
  /**
   * Tracks and shot data the workflows read, each with a `reference_id`
   * that a binding's `inputs` names, and a `source` saying how it is
   * produced (`external`, `required`, a `workflow` binding, or `mux_api`).
   * Up to 50.
   */
  resources?: Robots.CreateDirectiveRequest["resources"];
  /**
   * The workflows to run, each with a `reference_id` unique within the
   * Directive, the `workflow` name, optional `inputs` and `parameters`.
   */
  bindings: Robots.DirectiveBindings;
}

export interface DirectiveAttributes {
  /** Mux Directive ID (`drv_...`). Attach it with an asset's `directives: [{ id }]`. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** What the Directive runs on. */
  subject: Robots.DirectiveSubject;
  /** Tracks and shot data the workflows read. */
  resources: Robots.Directive["resources"];
  /** The workflows the Directive runs. */
  bindings: Robots.DirectiveBindings;
  /** Unix seconds of creation. */
  created_at: number;
}

export type Directive = Resource<
  "Mux.Robots.Directive",
  DirectiveProps,
  DirectiveAttributes,
  never,
  Providers
>;

/**
 * A Mux Robots Directive: several AI workflows (captions, translation,
 * chapters, summaries, moderation) run in dependency order on an asset.
 * Attach it to an asset's `directives` and it runs once the asset is ready.
 *
 * :::caution
 * Mux locks a Directive's configuration when it is created, so changing any
 * prop creates a new Directive and deletes the old one. Assets keep the runs
 * they already had.
 * :::
 * @see https://www.mux.com/docs/guides/robots-directives
 *
 * ### Creating a Directive
 * **Example:** Moderate every new asset
 * ```typescript
 * const moderation = yield* Mux.Robots.Directive("Moderation", {
 *   name: "Moderate new assets",
 *   bindings: [{ reference_id: "moderation", workflow: "moderate" }],
 * });
 * ```
 *
 * **Example:** English captions, then a Spanish translation
 * ```typescript
 * const captions = yield* Mux.Robots.Directive("Captions", {
 *   name: "Captions + Spanish",
 *   resources: [
 *     {
 *       reference_id: "captions_en",
 *       type: "video.asset.track",
 *       kind: "subtitles",
 *       language_code: "en",
 *       source: { via: "workflow", binding: "premium_captions" },
 *     },
 *   ],
 *   bindings: [
 *     {
 *       reference_id: "premium_captions",
 *       workflow: "generate-premium-captions",
 *       parameters: { language_code: "en" },
 *     },
 *     {
 *       reference_id: "translate_es",
 *       workflow: "translate-captions",
 *       inputs: ["captions_en"],
 *       parameters: { output_language_code: "es" },
 *     },
 *   ],
 * });
 * ```
 *
 * ### Running it on assets
 * **Example:** Attach the Directive to an asset
 * ```typescript
 * const moderation = yield* Mux.Robots.Directive("Moderation", {
 *   name: "Moderate new assets",
 *   bindings: [{ reference_id: "moderation", workflow: "moderate" }],
 * });
 * const asset = yield* Mux.Video.Asset("Intro", {
 *   inputs: [{ url: "https://example.com/intro.mp4" }],
 *   playback_policies: ["public"],
 *   directives: [{ id: moderation.id }],
 * });
 * ```
 *
 * @resource
 */
export const Directive = Resource<Directive>("Mux.Robots.Directive");

const toAttrs = (directive: Robots.Directive): DirectiveAttributes => ({
  id: directive.id,
  name: directive.name,
  subject: directive.subject,
  resources: directive.resources,
  bindings: directive.bindings,
  created_at: directive.created_at,
});

export const DirectiveProvider = () =>
  Provider.effect(
    Directive,
    Effect.gen(function* () {
      const create = yield* Robots.createDirective;
      const get = yield* Robots.getDirective;
      const del = yield* Robots.deleteDirective;
      const list = yield* Robots.listDirectives;

      const observe = (id: string) =>
        get({ DIRECTIVE_ID: id }).pipe(
          Effect.map((res) => toAttrs(res.data)),
          Effect.catchTag("NotFound", () => Effect.undefined),
        );

      return {
        stables: ["id", "created_at"],
        list: () =>
          list.items({ limit: 100 }).pipe(
            Stream.runCollect,
            Effect.flatMap((directives) => Effect.forEach(directives, (d) => observe(d.id))),
            Effect.map((directives) => directives.filter((d) => d !== undefined)),
          ),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (output === undefined) return undefined;
          if (!isResolved(news)) return { action: "replace" } as const;
          return deepEqual(olds, news) ? undefined : ({ action: "replace" } as const);
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          // The configuration is immutable, so an existing Directive is
          // already what `news` describes: any prop change replaced it.
          const observed = output?.id ? yield* observe(output.id) : undefined;
          if (observed !== undefined) return observed;
          // A create that failed with a 5xx may still have happened, so it
          // is retried only on throttling.
          const { data } = yield* create({
            name: news.name,
            subject: news.subject ?? { type: "video.asset" },
            resources: news.resources,
            bindings: news.bindings,
          }).pipe(MuxRetry.throttling);
          return toAttrs(data);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({ DIRECTIVE_ID: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          return yield* observe(output.id);
        }),
      };
    }),
  );
