import * as DO from "@distilled.cloud/digitalocean";
import type { SandboxTemplate } from "@distilled.cloud/digitalocean";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import { pollUntil, type PollBudget } from "../internal/poll.ts";
import type { Providers } from "../Providers.ts";

export type BaseTemplate =
  | "coding-base"
  | "coding-claude-code"
  | "coding-codex"
  | "coding-hermes"
  | "coding-opencode"
  | "langgraph";

export type TemplateProps = {
  /**
   * Template name. A change replaces the template.
   *
   * @default a generated physical name
   */
  name?: string;
  /** The base the image builds on. Updates in place (rebuilds). */
  baseTemplate: BaseTemplate;
  /**
   * The OCI image to build the sandbox from. It must be Debian- or
   * Ubuntu-based: the base templates are Ubuntu. Updates in place (rebuilds).
   */
  image: string;
};

export type Template = Resource<
  "DigitalOcean.Agents.Template",
  TemplateProps,
  {
    /** Template id. */
    templateId: string;
    /** Template name; reference it from an environment spec. */
    name: string;
    /** `TEMPLATE_STATUS_READY` once built. */
    status: string;
  },
  never,
  Providers
>;

export type TemplateAttributes = Template["Attributes"];

/**
 * A custom Harness Runtime sandbox template: an OCI image built on one of
 * DigitalOcean's agent bases. Environment specs refer to it by name. A new
 * `image` or `baseTemplate` rebuilds it in place.
 *
 * ### Building a Template
 * **Example:** A Claude Code sandbox with your tools
 * ```typescript
 * yield* DigitalOcean.Agents.Template("tools", {
 *   baseTemplate: "coding-claude-code",
 *   image: "ghcr.io/acme/agent-tools:1.4.0",
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Harness-Runtime
 *
 * @resource
 * @product Harness Runtime
 * @category AI
 */
export const Template = Resource<Template>("DigitalOcean.Agents.Template");

export class TemplateBuildFailed extends Data.TaggedError(
  "DigitalOcean.Agents.TemplateBuildFailed",
)<{
  readonly templateId: string;
  readonly status: string | undefined;
  readonly reason?: string | undefined;
}> {
  override get message() {
    return `Template ${this.templateId} did not build (status: ${this.status ?? "missing"})${this.reason ? `: ${this.reason}` : "."}`;
  }
}

// A build pulls and converts the image (≈ 20 min budget).
const BUILD_POLL: PollBudget = { maxDelay: "15 seconds", times: 80 };

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

const toAttrs = (template: SandboxTemplate): TemplateAttributes => ({
  templateId: template.template_id,
  name: template.name,
  status: template.status,
});

const observe = (templateId: string) =>
  noneIfNotFound(
    DO.getHarnessTemplate({ template_id: templateId }).pipe(Effect.map((r) => r.template)),
  );

// The newest build's error, to say why a template failed.
const latestBuildError = (templateId: string) =>
  DO.listHarnessTemplateBuilds({ template_id: templateId }).pipe(
    Effect.map(
      (r) =>
        [...(r.builds ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]?.error,
    ),
    Effect.orElseSucceed(() => undefined),
  );

const waitUntilBuilt = (templateId: string) =>
  pollUntil(observe(templateId), {
    ...BUILD_POLL,
    until: (o) =>
      Option.isSome(o) &&
      (o.value.status === "TEMPLATE_STATUS_READY" || o.value.status === "TEMPLATE_STATUS_FAILED"),
    onTimeout: (last) =>
      new TemplateBuildFailed({ templateId, status: Option.getOrUndefined(last)?.status }),
  }).pipe(
    Effect.flatMap((o) =>
      Option.isSome(o) && o.value.status === "TEMPLATE_STATUS_READY"
        ? Effect.succeed(o.value)
        : latestBuildError(templateId).pipe(
            Effect.flatMap((reason) =>
              Effect.fail(
                new TemplateBuildFailed({
                  templateId,
                  status: Option.getOrUndefined(o)?.status,
                  reason,
                }),
              ),
            ),
          ),
    ),
  );

export const TemplateProvider = () =>
  Provider.succeed(Template, {
    stables: ["templateId", "name"],
    nuke: { skip: true },
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const observed = yield* observe(output.templateId);
      return Option.getOrUndefined(Option.map(observed, toAttrs));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (news.name !== olds.name) return { action: "replace" } as const;
    }),
    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const name = news.name ?? output?.name ?? (yield* physicalName(id));
      const observed =
        output === undefined ? Option.none<SandboxTemplate>() : yield* observe(output.templateId);
      if (Option.isNone(observed)) {
        const { template } = yield* DO.createHarnessTemplate({
          name,
          base_template: news.baseTemplate,
          source_oci_ref: news.image,
        });
        const built = yield* waitUntilBuilt(template.template_id);
        return toAttrs(built);
      }
      // The image reference is write-only; a change is seen against the props.
      const changed =
        olds === undefined || olds.image !== news.image || olds.baseTemplate !== news.baseTemplate;
      if (changed) {
        yield* DO.updateHarnessTemplate({
          template_id: observed.value.template_id,
          source_oci_ref: news.image,
          base_template: news.baseTemplate,
        });
      }
      const built = yield* waitUntilBuilt(observed.value.template_id);
      return toAttrs(built);
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(DO.deleteHarnessTemplate({ template_id: output.templateId }));
    }),
  });
