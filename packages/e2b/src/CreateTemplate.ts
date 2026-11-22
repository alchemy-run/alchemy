import type * as tags from "@distilled.cloud/e2b/tags";
import type * as templates from "@distilled.cloud/e2b/templates";
import type * as unstable from "@distilled.cloud/e2b/unstable";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import type { TemplateBuildFailed } from "./Errors.ts";
import type { TemplateBuildSpec } from "./internal/TemplateBuild.ts";
import type { E2BError } from "./SandboxClient.ts";

/**
 * What a runtime build takes: E2B's own build inputs (a base `image` or
 * `fromTemplate`, then `env`, `files` and `run` steps), with no Dockerfile.
 * Files come from memory; there is no build-context directory where a
 * Worker runs.
 */
export type RuntimeTemplateSpec = TemplateBuildSpec;

/** A built template. */
export interface TemplateInfo {
  readonly templateId: string;
  readonly buildId: string;
  /** Fully qualified names, e.g. `my-team/my-template:default`. */
  readonly names: ReadonlyArray<string>;
}

/** Errors a runtime build can fail with. */
export type TemplateBuildError = E2BError | TemplateBuildFailed | PlatformError.PlatformError;

/** E2B templates: build, look up, tag and delete them at runtime. */
export interface TemplatesClient {
  /** Builds a template and waits until it is ready. */
  build(spec: RuntimeTemplateSpec): Effect.Effect<TemplateInfo, TemplateBuildError, RuntimeContext>;
  /**
   * Builds a template unless a ready build of these exact inputs exists.
   * Each build is tagged with its content hash, so a repeat call is one
   * lookup.
   */
  getOrBuild(
    spec: RuntimeTemplateSpec,
  ): Effect.Effect<TemplateInfo, TemplateBuildError, RuntimeContext>;
  /** A template by id or name (alias), or `undefined`. */
  get(
    nameOrId: string,
  ): Effect.Effect<templates.GetTemplateResponse | undefined, E2BError, RuntimeContext>;
  /** The team's templates. */
  list(
    options?: Omit<templates.ListTemplatesRequest, "teamID" | "nextToken">,
  ): Effect.Effect<ReadonlyArray<templates.Template>, E2BError, RuntimeContext>;
  /** E2B's public base templates. */
  listDefaults(): Effect.Effect<templates.ListDefaultTemplatesResponse, E2BError, RuntimeContext>;
  /** Templates matching a search. */
  search(
    options: unstable.SearchTemplatesRequest,
  ): Effect.Effect<unstable.TemplateSearchResponse, E2BError, RuntimeContext>;
  /** Whether other teams can create sandboxes from the template. */
  setPublic(templateId: string, isPublic: boolean): Effect.Effect<void, E2BError, RuntimeContext>;
  /** A build's status, with its newest log lines. */
  buildStatus(
    templateId: string,
    buildId: string,
    options?: Omit<templates.GetTemplateBuildStatusRequest, "templateID" | "buildID">,
  ): Effect.Effect<templates.TemplateBuildInfo, E2BError, RuntimeContext>;
  /** A build's logs. */
  buildLogs(
    templateId: string,
    buildId: string,
    options?: Omit<templates.ListTemplateBuildLogsRequest, "templateID" | "buildID">,
  ): Effect.Effect<templates.TemplateBuildLogsResponse, E2BError, RuntimeContext>;
  /** Deletes a template. Deleting one that is gone succeeds. */
  delete(templateId: string): Effect.Effect<void, E2BError, RuntimeContext>;
  /** Tags on builds: `name:tag` names a build sandboxes are created from. */
  readonly tags: {
    /** Assigns tags to the build `target` (`name:tag` or `name`) points at. */
    assign(
      target: string,
      tags: ReadonlyArray<string>,
    ): Effect.Effect<tags.AssignedTemplateTags, E2BError, RuntimeContext>;
    /** Removes tags from a template by name. */
    remove(
      name: string,
      tags: ReadonlyArray<string>,
    ): Effect.Effect<void, E2BError, RuntimeContext>;
    list(
      templateId: string,
    ): Effect.Effect<tags.ListTemplateTagsResponse, E2BError, RuntimeContext>;
    exists(templateId: string, tag: string): Effect.Effect<boolean, E2BError, RuntimeContext>;
    count(templateId: string): Effect.Effect<number, E2BError, RuntimeContext>;
    groups(
      templateId: string,
      options?: Omit<tags.ListTemplateTagGroupsRequest, "templateID">,
    ): Effect.Effect<tags.TemplateTagGroupsResponse, E2BError, RuntimeContext>;
    assignments(
      templateId: string,
      tag: string,
      options?: Omit<tags.ListTemplateTagAssignmentsRequest, "templateID" | "tag">,
    ): Effect.Effect<tags.TemplateTagAssignmentsResponse, E2BError, RuntimeContext>;
  };
}

/**
 * Build E2B templates at runtime from E2B's own build inputs: a template
 * per repository, per customer image, per agent configuration.
 * E2B builds remotely, so this works from a Worker.
 *
 * Templates built at runtime carry no metadata, so they are not deleted
 * when the host is destroyed. Delete them with `delete` when their owner
 * goes away.
 *
 * ### Building at runtime
 * **Example:** A template per repository, built once
 * ```typescript
 * const templates = yield* E2B.CreateTemplate();
 * const sandboxes = yield* E2B.CreateSandbox();
 * // in fetch:
 * const template = yield* templates.getOrBuild({
 *   name: `repo-${slug}`,
 *   image: "node:22-bookworm",
 *   files: [{ path: "/home/user/app/package.json", contents: packageJson }],
 *   run: ["cd /home/user/app && npm install"],
 * });
 * const sandbox = yield* sandboxes.create({ templateID: template.templateId });
 * ```
 *
 * @binding
 * @product Template
 */
export interface CreateTemplate extends Binding.Service<
  CreateTemplate,
  "E2B.CreateTemplate",
  () => Effect.Effect<TemplatesClient>
> {}

export const CreateTemplate = Binding.Service<CreateTemplate>("E2B.CreateTemplate");
