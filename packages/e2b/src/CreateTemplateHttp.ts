import * as tags from "@distilled.cloud/e2b/tags";
import * as templates from "@distilled.cloud/e2b/templates";
import * as unstable from "@distilled.cloud/e2b/unstable";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  CreateTemplate,
  type RuntimeTemplateSpec,
  type TemplateInfo,
  type TemplatesClient,
} from "./CreateTemplate.ts";
import { bindE2B } from "./E2BBindings.ts";
import { planTemplateBuild, runTemplateBuild } from "./internal/TemplateBuild.ts";

/** The tag a build of these inputs carries. */
const hashTag = (hash: string) => `alchemy-${hash.slice(0, 16)}`;

/**
 * HTTP implementation of {@link CreateTemplate}. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const templates = yield* E2B.CreateTemplate();
 *   // ...
 * }).pipe(Effect.provide(E2B.CreateTemplateHttp))
 * ```
 *
 * @layer
 * @product Template
 * @provides E2B.CreateTemplate
 */
export const CreateTemplateHttp = Layer.succeed(
  CreateTemplate,
  Effect.fn("E2B.CreateTemplate")(function* () {
    const auth = yield* bindE2B;

    const get = (nameOrId: string) =>
      auth
        .authorize(
          templates
            .getTemplate({ templateID: nameOrId })
            .pipe(
              Effect.catchTag("NotFound", () =>
                templates
                  .getTemplateByAlias({ alias: nameOrId })
                  .pipe(
                    Effect.flatMap((alias) =>
                      templates.getTemplate({ templateID: alias.templateID }),
                    ),
                  ),
              ),
            ),
        )
        .pipe(
          Effect.map((template): templates.GetTemplateResponse | undefined => template),
          Effect.catchTag("NotFound", () => Effect.undefined),
        );

    const build = Effect.fn("E2B.CreateTemplate.build")(function* (spec: RuntimeTemplateSpec) {
      const plan = yield* planTemplateBuild(spec);
      const built = yield* auth.authorize(
        // E2B builds the `default` tag only when no tags are given, so keep it
        // next to the hash tag unless the caller chose its own.
        runTemplateBuild(
          { ...spec, tags: [...(spec.tags ?? ["default"]), hashTag(plan.hash)] },
          plan,
        ),
      );
      return {
        templateId: built.templateId,
        buildId: built.buildId,
        names: built.names,
      } satisfies TemplateInfo;
    });

    const client: TemplatesClient = {
      build,
      getOrBuild: Effect.fn("E2B.CreateTemplate.getOrBuild")(function* (spec) {
        const plan = yield* planTemplateBuild(spec);
        const existing = yield* get(spec.name);
        if (existing !== undefined) {
          const tagged = yield* auth.authorize(
            tags.getTemplateTagExists({ templateID: existing.templateID, tag: hashTag(plan.hash) }),
          );
          const ready =
            existing.builds.find((b) => b.buildID === existing.buildID)?.status === "ready";
          if (tagged.exists && ready) {
            return {
              templateId: existing.templateID,
              buildId: existing.buildID,
              names: existing.names,
            };
          }
        }
        return yield* build(spec);
      }),
      get,
      list: (options) =>
        auth
          .authorize(Stream.runCollect(templates.listTemplates.items({ ...options })))
          .pipe(Effect.map((all) => Array.from(all))),
      listDefaults: () => auth.authorize(templates.listDefaultTemplates({})),
      search: (options) => auth.authorize(unstable.searchTemplates(options)),
      setPublic: (templateId, isPublic) =>
        auth
          .authorize(templates.updateTemplate({ templateID: templateId, public: isPublic }))
          .pipe(Effect.asVoid),
      buildStatus: (templateId, buildId, options) =>
        auth.authorize(
          templates.getTemplateBuildStatus({
            ...options,
            templateID: templateId,
            buildID: buildId,
          }),
        ),
      buildLogs: (templateId, buildId, options) =>
        auth.authorize(
          templates.listTemplateBuildLogs({ ...options, templateID: templateId, buildID: buildId }),
        ),
      delete: (templateId) =>
        auth.authorize(templates.deleteTemplate({ templateID: templateId })).pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        ),
      tags: {
        assign: (target, assigned) =>
          auth.authorize(tags.createTemplateTag({ target, tags: [...assigned] })),
        remove: (name, removed) =>
          auth.authorize(tags.deleteTemplateTags({ name, tags: [...removed] })).pipe(Effect.asVoid),
        list: (templateId) => auth.authorize(tags.listTemplateTags({ templateID: templateId })),
        exists: (templateId, tag) =>
          auth
            .authorize(tags.getTemplateTagExists({ templateID: templateId, tag }))
            .pipe(Effect.map((res) => res.exists)),
        count: (templateId) =>
          auth
            .authorize(tags.getTemplateTagCount({ templateID: templateId }))
            .pipe(Effect.map((res) => res.total)),
        groups: (templateId, options) =>
          auth.authorize(tags.listTemplateTagGroups({ ...options, templateID: templateId })),
        assignments: (templateId, tag, options) =>
          auth.authorize(
            tags.listTemplateTagAssignments({ ...options, templateID: templateId, tag }),
          ),
      },
    };
    return client;
  }),
);
