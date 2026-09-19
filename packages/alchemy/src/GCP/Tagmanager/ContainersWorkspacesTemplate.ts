import * as tagmanager from "@distilled.cloud/gcp/tagmanager_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  eachWorkspace,
  encodeOwnershipLine,
  resolveWorkspace,
  hasOwnershipMarker,
  internalLabels,
  lastSegment,
  listTemplatesAt,
  ownedByAlchemy,
  parseOwnership,
  parsePath,
  retryConflict,
  sameBool,
  sameJson,
  sameText,
  TagmanagerNotResolved,
  toDisplayName,
} from "./internal.ts";

export type GalleryReference = {
  /** Gallery template host. */
  host?: string;
  /** Gallery template owner. */
  owner?: string;
  /** Gallery template repository. */
  repository?: string;
  /** Gallery template version. */
  version?: string;
  /** Developer id of the gallery template. */
  templateDeveloperId?: string;
  /** Stable gallery template id. */
  galleryTemplateId?: string;
  /** Whether the user edited the gallery template. */
  isModified?: boolean;
  /** Import-time signature. */
  signature?: string;
};

export type ContainersWorkspacesTemplateProps = {
  /**
   * Parent workspace path
   * (`accounts/{account}/containers/{container}/workspaces/{workspace}`)
   * or workspace id when `container` is also set. Immutable — changing
   * it replaces the template.
   */
  workspace: string;
  /**
   * Parent container path used when `workspace` is an id. Immutable —
   * changing it replaces the template.
   */
  container?: string;
  /**
   * Custom template id. Server-assigned when omitted. Immutable —
   * changing it replaces the template.
   */
  templateId?: string;
  /**
   * Template display name. Custom templates have no notes field, so
   * Alchemy stamps ownership into this name and strips it from
   * attributes. Generated when omitted.
   */
  name?: string;
  /**
   * Custom template contents in GTM template-text format.
   */
  templateData?: string;
  /**
   * Community Template Gallery reference.
   */
  galleryReference?: GalleryReference;
};

export type ContainersWorkspacesTemplate = Resource<
  "GCP.Tagmanager.ContainersWorkspacesTemplate",
  ContainersWorkspacesTemplateProps,
  {
    /** GTM API path `.../workspaces/{workspace}/templates/{template}`. */
    path: string;
    /** Parent workspace path. */
    workspace: string;
    /** Parent container path. */
    container: string;
    /** Parent account path. */
    account: string;
    /** GTM account id. */
    accountId: string;
    /** GTM container id. */
    containerId: string;
    /** GTM workspace id. */
    workspaceId: string;
    /** Custom template id. */
    templateId: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    name: string | undefined;
    /** Template text. */
    templateData: string | undefined;
    /** Gallery reference. */
    galleryReference: GalleryReference | undefined;
    /** Tag Manager UI URL. */
    tagManagerUrl: string | undefined;
    /** Storage fingerprint used for optimistic updates. */
    fingerprint: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Tag Manager custom template in a workspace.
 *
 * Custom templates have no notes field — Alchemy stamps ownership into
 * the display name so `list` / nuke can find them. Parent workspace and
 * id are immutable. Name, template text, and gallery reference update in
 * place.
 *
 * ### Creating a Template
 * **Example:** Constant variable template
 * ```typescript
 * const template = yield* GCP.Tagmanager.ContainersWorkspacesTemplate("Const", {
 *   workspace: workspace.path,
 *   name: "const",
 *   templateData:
 *     "___INFO___\\n{\\n  \\"type\\": \\"MACRO\\",\\n  \\"id\\": \\"cvt_temp_id\\",\\n  \\"version\\": 1,\\n  \\"displayName\\": \\"const\\",\\n  \\"containerContexts\\": [\\"WEB\\"]\\n}\\n\\n___SANDBOXED_JS_FOR_WEB_TEMPLATE___\\n\\nreturn 'alchemy';\\n",
 * });
 * ```
 *
 * ### Updating a Template
 * **Example:** Rename
 * ```typescript
 * const template = yield* GCP.Tagmanager.ContainersWorkspacesTemplate("Const", {
 *   workspace: existing.workspace,
 *   templateId: existing.templateId,
 *   name: "const-v2",
 *   templateData: existing.templateData,
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Tagmanager
 */
export const ContainersWorkspacesTemplate =
  Resource<ContainersWorkspacesTemplate>(
    "GCP.Tagmanager.ContainersWorkspacesTemplate",
  );

export class ContainersWorkspacesTemplateNotResolved extends Data.TaggedError(
  "GCP.Tagmanager.ContainersWorkspacesTemplateNotResolved",
)<{
  path: string;
}> {}

const galleryOf = (
  reference: tagmanager.GalleryReference | GalleryReference | undefined,
): GalleryReference | undefined => {
  if (reference === undefined) return undefined;
  return {
    host: reference.host,
    owner: reference.owner,
    repository: reference.repository,
    version: reference.version,
    templateDeveloperId: reference.templateDeveloperId,
    galleryTemplateId: reference.galleryTemplateId,
    isModified: reference.isModified,
    signature: reference.signature,
  };
};

const toAttrs = (
  template: tagmanager.CustomTemplate,
  workspaceHint?: string,
) => {
  const path = template.path ?? "";
  const parsed = parsePath(path);
  return {
    path,
    workspace: parsed.workspace || workspaceHint || "",
    container: parsed.container,
    account: parsed.account,
    accountId: template.accountId ?? parsed.accountId ?? "",
    containerId: template.containerId ?? parsed.containerId ?? "",
    workspaceId: template.workspaceId ?? parsed.workspaceId ?? "",
    templateId: template.templateId ?? parsed.templateId ?? lastSegment(path),
    name: parseOwnership(template.name).text,
    templateData: template.templateData,
    galleryReference: galleryOf(template.galleryReference),
    tagManagerUrl: template.tagManagerUrl,
    fingerprint: template.fingerprint,
  };
};

const getByPath = (path: string) =>
  path.length === 0
    ? Effect.succeed(undefined)
    : tagmanager
        .getAccountsContainersWorkspacesTemplates({ path })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (workspace: string, id: string, name: string | undefined) =>
  listTemplatesAt(workspace).pipe(
    Effect.flatMap((templates) =>
      Effect.gen(function* () {
        for (const template of templates) {
          if (name !== undefined && template.name === name) return template;
          if (yield* ownedByAlchemy(id, template.name)) return template;
        }
        return undefined;
      }),
    ),
  );

export const ContainersWorkspacesTemplateProvider = () =>
  Provider.succeed(ContainersWorkspacesTemplate, {
    stables: [
      "path",
      "workspace",
      "container",
      "account",
      "accountId",
      "containerId",
      "workspaceId",
      "templateId",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousWorkspace = olds?.workspace ?? output?.workspace;
      if (
        previousWorkspace !== undefined &&
        resolveWorkspace(news.workspace, news.container) !==
          resolveWorkspace(previousWorkspace)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.templateId ?? output?.templateId;
      if (
        previousId !== undefined &&
        news.templateId !== undefined &&
        news.templateId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const workspace = resolveWorkspace(
        olds?.workspace ?? output?.workspace ?? "",
        olds?.container ?? output?.container,
      );
      const path =
        output?.path ??
        (olds?.templateId && workspace
          ? `${workspace}/templates/${olds.templateId}`
          : "");
      let existing = yield* getByPath(path);
      if (existing === undefined && workspace.length > 0) {
        existing = yield* findOwned(workspace, id, undefined);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, workspace);
      return (yield* ownedByAlchemy(id, existing.name))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      eachWorkspace((workspace) =>
        listTemplatesAt(workspace).pipe(
          Effect.map((templates) =>
            templates
              .filter((template) => hasOwnershipMarker(template.name))
              .map((template) => toAttrs(template, workspace)),
          ),
        ),
      ),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const workspace = resolveWorkspace(news.workspace, news.container);
      const path =
        output?.path ??
        (news.templateId ? `${workspace}/templates/${news.templateId}` : "");
      const ownership = yield* internalLabels(id);
      const userName = yield* toDisplayName(id, news.name, output?.name);
      const name = encodeOwnershipLine(ownership, userName);
      const body: tagmanager.CustomTemplate = {
        name,
        templateData: news.templateData,
        galleryReference: news.galleryReference,
      };

      let current = yield* getByPath(output?.path ?? path);
      if (current === undefined) {
        current = yield* findOwned(workspace, id, name);
      }

      if (current === undefined) {
        const created = yield* tagmanager
          .createAccountsContainersWorkspacesTemplates({
            parent: workspace,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () => findOwned(workspace, id, name)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ContainersWorkspacesTemplateNotResolved({
          path: path || `${workspace}/templates/-`,
        });
      }

      if (!(yield* ownedByAlchemy(id, current.name))) {
        return yield* new TagmanagerNotResolved({
          path: current.path ?? path,
        });
      }

      const currentPath = current.path ?? path;
      const observed = toAttrs(current, workspace);
      const changed =
        !sameText(current.name, name) ||
        !sameText(current.templateData, news.templateData) ||
        !sameJson(observed.galleryReference, news.galleryReference) ||
        !sameBool(
          current.galleryReference?.isModified,
          news.galleryReference?.isModified,
        );

      if (changed) {
        const updated = yield* retryConflict(
          Effect.gen(function* () {
            const fresh = yield* getByPath(currentPath);
            if (fresh === undefined) return undefined;
            return yield* tagmanager.updateAccountsContainersWorkspacesTemplates(
              {
                path: currentPath,
                fingerprint: fresh.fingerprint,
                body: {
                  ...body,
                  path: currentPath,
                  accountId: fresh.accountId,
                  containerId: fresh.containerId,
                  workspaceId: fresh.workspaceId,
                  templateId: fresh.templateId,
                },
              },
            );
          }),
        );
        current = updated ?? current;
      }

      return toAttrs(current, workspace);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* tagmanager
        .deleteAccountsContainersWorkspacesTemplates({ path: output.path })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
