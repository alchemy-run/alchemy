import * as apphub from "@distilled.cloud/gcp/apphub_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  type Attributes,
  type Scope,
  defaultScope,
  encodeOwnership,
  fieldMask,
  listAtLocations,
  listOwnedPages,
  locationParent,
  normalizeLocation,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  ResourceNotResolved,
  sameJson,
  sameText,
  toPhysicalId,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type ApplicationProps = {
  /**
   * Application id (the `{application}` segment of
   * `projects/{project}/locations/{location}/applications/{application}`).
   * Must be lowercase letters, numbers, or hyphens (RFC1035, 63 chars).
   * If omitted, a unique name is generated. Immutable — changing it
   * replaces the application.
   */
  applicationId?: string;
  /**
   * Region (`us-central1`, …) or `global`. Immutable — changing it
   * replaces the application. `US-CENTRAL1` is accepted and normalized
   * to `us-central1`. Regional applications use `scope.type = REGIONAL`;
   * global applications use `scope.type = GLOBAL`.
   * @default "us-central1"
   */
  location?: string;
  /**
   * User-defined display name. Maximum length is 63 characters. Defaults
   * to the application id.
   */
  displayName?: string;
  /**
   * User-defined description. Maximum length is 2048 characters.
   * Applications have no labels field, so Alchemy stamps ownership into
   * a `[alchemy …]` prefix and strips it from attributes.
   */
  description?: string;
  /**
   * Consumer-provided attributes (criticality, environment, owners).
   */
  attributes?: Attributes;
  /**
   * Immutable governance boundary. Limits which Services and Workloads
   * can be registered. Defaults to `REGIONAL` (or `GLOBAL` when
   * `location` is `global`). Changing it replaces the application.
   */
  scope?: Scope;
};

export type Application = Resource<
  "GCP.Apphub.Application",
  ApplicationProps,
  {
    /** Full resource name. */
    name: string;
    /** Application id (last path segment). */
    applicationId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User-defined display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Consumer-provided attributes. */
    attributes: Attributes | undefined;
    /** Immutable scope. */
    scope: Scope | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** Server-generated resource uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An App Hub application — the governance boundary for services and
 * workloads that perform a logical end-to-end business function.
 *
 * Applications have no labels field, so Alchemy stamps ownership into
 * the description for `list` / nuke. Id, location, and scope are
 * immutable. Display name, description, and attributes update in place.
 *
 * ### Creating an Application
 * **Example:** Regional application
 * ```typescript
 * const app = yield* GCP.Apphub.Application("Checkout", {
 *   location: "us-central1",
 *   displayName: "checkout",
 *   scope: { type: "REGIONAL" },
 * });
 * ```
 *
 * **Example:** Attributes and description
 * ```typescript
 * const app = yield* GCP.Apphub.Application("Checkout", {
 *   displayName: "checkout",
 *   description: "payments",
 *   attributes: {
 *     criticality: { type: "HIGH" },
 *     environment: { type: "PRODUCTION" },
 *   },
 * });
 * ```
 *
 * ### Updating an Application
 * **Example:** Display name and criticality
 * ```typescript
 * const app = yield* GCP.Apphub.Application("Checkout", {
 *   applicationId: existing.applicationId,
 *   displayName: "checkout-v2",
 *   description: "payments v2",
 *   attributes: {
 *     criticality: { type: "MISSION_CRITICAL" },
 *     environment: { type: "PRODUCTION" },
 *   },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Apphub
 */
export const Application = Resource<Application>("GCP.Apphub.Application");

const resourceName = (
  project: string,
  location: string,
  applicationId: string,
) => `${locationParent(project, location)}/applications/${applicationId}`;

const toAttrs = (item: apphub.Application, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "applications");
  const ownership = parseOwnership(item.description);
  return {
    name,
    applicationId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: item.displayName,
    description: ownership.text,
    attributes: item.attributes,
    scope: item.scope,
    state: item.state,
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : apphub
        .getProjectsLocationsApplications({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtLocations(project, (parent) =>
    listOwnedPages(
      apphub.listProjectsLocationsApplications.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.applications,
      (item) => item.description,
    ),
  );

export const ApplicationProvider = () =>
  Provider.succeed(Application, {
    stables: [
      "name",
      "applicationId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousScope = olds?.scope?.type ?? output?.scope?.type;
      const nextScope = news.scope?.type ?? previousScope;
      return replaceOnIdentity({
        previousId: olds?.applicationId ?? output?.applicationId,
        nextId:
          news.applicationId ?? olds?.applicationId ?? output?.applicationId,
        previousLocation: normalizeLocation(olds?.location ?? output?.location),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
        ),
        extra:
          previousScope !== undefined &&
          nextScope !== undefined &&
          previousScope !== nextScope,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const applicationId = yield* toPhysicalId(
        id,
        olds?.applicationId,
        output?.applicationId,
        "app",
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ?? resourceName(env.project, location, applicationId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const applicationId = yield* toPhysicalId(
        id,
        news.applicationId,
        output?.applicationId,
        "app",
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(env.project, location, applicationId);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? applicationId;
      const scope = news.scope ?? defaultScope(location);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* apphub
          .createProjectsLocationsApplications({
            parent: locationParent(env.project, location),
            applicationId,
            body: {
              displayName,
              description,
              attributes: news.attributes,
              scope,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item) => item.state,
      );

      const mask = fieldMask([
        !sameText(current.description, description) && "description",
        !sameText(current.displayName, displayName) && "displayName",
        news.attributes !== undefined &&
          !sameJson(current.attributes, news.attributes) &&
          "attributes",
      ]);

      if (mask.length > 0) {
        const operation = yield* apphub.patchProjectsLocationsApplications({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            displayName,
            description,
            attributes: news.attributes,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item) => item.state,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* apphub
        .deleteProjectsLocationsApplications({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
