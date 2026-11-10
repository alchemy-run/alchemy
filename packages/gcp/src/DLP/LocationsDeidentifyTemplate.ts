import * as dlp from "@distilled.cloud/gcp/dlp_v2";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { GcpEnvironment } from "../Environment.ts";
import { inLookupProject } from "../internal/Lookup.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  collectPages,
  encodeOwnership,
  hasOwnershipMarker,
  jsonEqual,
  lastSegment,
  locationOf,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  projectOf,
  replaceOnIdentity,
  sameText,
  toResourceId,
  updateMaskOf,
} from "./internal.ts";

export type LocationsDeidentifyTemplateProps = {
  /**
   * Template id (the `{deidentifyTemplate}` segment of
   * `projects/{project}/locations/{location}/deidentifyTemplates/{id}`).
   * If omitted, a unique name is generated. Must match `[a-zA-Z0-9_-]+`
   * and is at most 100 characters. Immutable — changing it replaces the
   * template.
   */
  templateId?: string;
  /**
   * Processing location (`global`, `us`, `us-central1`, …). Immutable —
   * changing it replaces the template.
   * @default "global"
   */
  location?: string;
  /**
   * Display name (max 256 characters).
   */
  displayName?: string;
  /**
   * Human-readable description (max 256 characters). Deidentify templates
   * have no labels field, so Alchemy ownership is stored in a
   * `[alchemy …]` prefix and stripped from attributes.
   */
  description?: string;
  /**
   * De-identify configuration applied when this template is referenced.
   */
  deidentifyConfig?: dlp.GooglePrivacyDlpV2DeidentifyConfig;
};

export type LocationsDeidentifyTemplate = Resource<
  "GCP.DLP.LocationsDeidentifyTemplate",
  LocationsDeidentifyTemplateProps,
  {
    /** Full resource name. */
    name: string;
    /** Template id (last path segment). */
    templateId: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** De-identify configuration. */
    deidentifyConfig: dlp.GooglePrivacyDlpV2DeidentifyConfig | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers,
  LocationsDeidentifyTemplateLookup
>;

/**
 * Props for {@link LocationsDeidentifyTemplate.lookup}: find a locations
 * deidentify template this stack doesn't manage by its identifiers, in the
 * ambient project unless `project` names another.
 */
export interface LocationsDeidentifyTemplateLookup {
  /**
   * Template id (the `{deidentifyTemplate}` segment of
   * `projects/{project}/locations/{location}/deidentifyTemplates/{id}`).
   * Must match `[a-zA-Z0-9_-]+` and is at most 100 characters.
   */
  templateId: string;
  /**
   * Processing location (`global`, `us`, `us-central1`, …).
   */
  location?: string;
  /**
   * Project the resource lives in.
   * @default the ambient GCP project
   */
  project?: string;
}

/**
 * A location-scoped Cloud DLP de-identify template.
 *
 * Templates have no labels field, so Alchemy stamps ownership into the
 * description for `list` / nuke. Location and template id are identity —
 * changing them replaces the template. Display name, description, and
 * de-identify config update in place.
 *
 * ### Creating a Location Deidentify Template
 * **Example:** Redact emails in `global`
 * ```typescript
 * const template = yield* GCP.DLP.LocationsDeidentifyTemplate("Emails", {
 *   location: "global",
 *   displayName: "redact emails",
 *   deidentifyConfig: {
 *     infoTypeTransformations: {
 *       transformations: [
 *         {
 *           infoTypes: [{ name: "EMAIL_ADDRESS" }],
 *           primitiveTransformation: { replaceWithInfoTypeConfig: {} },
 *         },
 *       ],
 *     },
 *   },
 * });
 * ```
 *
 * ### Looking up an existing locations deidentify template
 * `LocationsDeidentifyTemplate.lookup` references a locations deidentify
 * template Alchemy doesn't manage (created in the console or by another
 * stack). It is read during plan/deploy, never created, updated or deleted,
 * and binds like a declared locations deidentify template.
 *
 * **Example:** Reference an existing locations deidentify template
 * ```typescript
 * const locationsDeidentifyTemplate = GCP.DLP.LocationsDeidentifyTemplate.lookup({
 *   templateId: "my-template",
 * });
 * ```
 *
 * @resource
 * @category DLP
 */
export const LocationsDeidentifyTemplate = Resource<LocationsDeidentifyTemplate>(
  "GCP.DLP.LocationsDeidentifyTemplate",
);

export class LocationsDeidentifyTemplateNotResolved extends Data.TaggedError(
  "GCP.DLP.LocationsDeidentifyTemplateNotResolved",
)<{
  resourceName: string;
}> {}

const resourceName = (project: string, location: string, templateId: string) =>
  `${locationParent(project, location)}/deidentifyTemplates/${templateId}`;

const toAttrs = (template: dlp.GooglePrivacyDlpV2DeidentifyTemplate, project: string) => {
  const name = template.name ?? "";
  const parsed = parseOwnership(template.description);
  return {
    name,
    templateId: lastSegment(name),
    location: locationOf(name),
    project: projectOf(name) || project,
    displayName: template.displayName,
    description: parsed.text,
    deidentifyConfig: template.deidentifyConfig,
    createTime: template.createTime,
    updateTime: template.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.undefined
    : dlp
        .getProjectsLocationsDeidentifyTemplates({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

export const LocationsDeidentifyTemplateProvider = () =>
  Provider.succeed(LocationsDeidentifyTemplate, {
    stables: ["name", "templateId", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.templateId ?? output?.templateId;
      const idChanged =
        previousId !== undefined && news.templateId !== undefined && news.templateId !== previousId;
      const previousLocation = olds?.location ?? output?.location;
      const locationChanged =
        previousLocation !== undefined &&
        news.location !== undefined &&
        normalizeLocation(news.location) !== normalizeLocation(previousLocation);
      return replaceOnIdentity(idChanged || locationChanged);
    }),

    lookup: Effect.fn(function* ({ templateId, location: lookupLocation }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(lookupLocation);
      const name = resourceName(env.project, location, templateId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      return toAttrs(existing, env.project);
    }, inLookupProject),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const templateId = yield* toResourceId(id, olds?.templateId, output?.templateId);
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name = output?.name ?? resourceName(env.project, location, templateId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          dlp.listProjectsLocationsDeidentifyTemplates.pages({
            parent: locationParent(env.project, DEFAULT_LOCATION),
            pageSize: 100,
          }),
          (page) => page.deidentifyTemplates,
        ).pipe(
          Effect.catchTag("NotFound", () =>
            Effect.succeed([] as dlp.GooglePrivacyDlpV2DeidentifyTemplate[]),
          ),
        );
        return items
          .filter((template) => hasOwnershipMarker(template.description))
          .map((template) => toAttrs(template, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location ?? DEFAULT_LOCATION);
      const templateId = yield* toResourceId(id, news.templateId, output?.templateId);
      const name = resourceName(env.project, location, templateId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const body: dlp.GooglePrivacyDlpV2DeidentifyTemplate = {
        displayName: news.displayName,
        description,
        deidentifyConfig: news.deidentifyConfig,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dlp
          .createProjectsLocationsDeidentifyTemplates({
            parent: locationParent(env.project, location),
            body: {
              templateId,
              deidentifyTemplate: body,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new LocationsDeidentifyTemplateNotResolved({ resourceName: name });
      }

      const displayChanged = !sameText(current.displayName, news.displayName);
      const descriptionChanged = (current.description ?? "") !== description;
      const configChanged = !jsonEqual(current.deidentifyConfig, news.deidentifyConfig);

      if (displayChanged || descriptionChanged || configChanged) {
        current = yield* dlp.patchProjectsLocationsDeidentifyTemplates({
          name: current.name ?? name,
          body: {
            deidentifyTemplate: body,
            updateMask: updateMaskOf(
              displayChanged ? "displayName" : undefined,
              descriptionChanged ? "description" : undefined,
              configChanged ? "deidentifyConfig" : undefined,
            ),
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dlp
        .deleteProjectsLocationsDeidentifyTemplates({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
