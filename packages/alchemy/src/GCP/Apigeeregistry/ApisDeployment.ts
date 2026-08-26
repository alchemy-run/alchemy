import * as registry from "@distilled.cloud/gcp/apigeeregistry_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  annotationsOf,
  expandParent,
  hasAlchemyLabelMap,
  ignoreGone,
  listApis,
  listChildResources,
  listDeployments,
  locationParent,
  missingGet,
  namedOf,
  normalizeLocation,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  sameJson,
  sameText,
  toPhysicalId,
  updateMaskOf,
  userLabels,
  RegistryNotResolved,
} from "./internal.ts";

export type ApisDeploymentProps = {
  /**
   * Parent API. Full name
   * `projects/{project}/locations/{location}/apis/{api}` or the API id
   * (combined with `location`). Immutable — changing it replaces the
   * deployment.
   */
  api: string;
  /**
   * Deployment id (the `{deployment}` segment of
   * `.../apis/{api}/deployments/{deployment}`). If omitted, a unique id
   * is generated. Immutable — changing it replaces the deployment.
   */
  deploymentId?: string;
  /**
   * Location used when `api` is a bare id.
   * @default "us-central1"
   */
  location?: string;
  /**
   * Display name. Defaults to the deployment id.
   */
  displayName?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * Address where the deployment is serving. Changing this commits a
   * new revision.
   */
  endpointUri?: string;
  /**
   * Full resource name (including revision) of the spec being served.
   * Changing this commits a new revision.
   */
  apiSpecRevision?: string;
  /**
   * Intended audience of the API.
   */
  intendedAudience?: string;
  /**
   * External channel URI (developer portal, …).
   */
  externalChannelUri?: string;
  /**
   * Brief guidance on how to access the endpoint.
   */
  accessGuidance?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Non-identifying metadata. Not used for ownership.
   */
  annotations?: Record<string, string>;
};

export type ApisDeployment = Resource<
  "GCP.Apigeeregistry.ApisDeployment",
  ApisDeploymentProps,
  {
    /** Full resource name. */
    name: string;
    /** Deployment id (last path segment). */
    deploymentId: string;
    /** Parent API resource name. */
    api: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Description. */
    description: string | undefined;
    /** Serving address. */
    endpointUri: string | undefined;
    /** Spec revision being served. */
    apiSpecRevision: string | undefined;
    /** Intended audience. */
    intendedAudience: string | undefined;
    /** External channel URI. */
    externalChannelUri: string | undefined;
    /** Access guidance. */
    accessGuidance: string | undefined;
    /** Current revision id. */
    revisionId: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Annotations. */
    annotations: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 revision creation timestamp. */
    revisionCreateTime: string | undefined;
    /** RFC3339 last revision update timestamp. */
    revisionUpdateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Apigee Registry API deployment — a service running at an address
 * that serves a particular API version.
 *
 * Parent API, location, and deployment id are immutable. Display name,
 * description, endpoint, spec revision, audience, labels, and
 * annotations update in place. Endpoint and spec revision changes
 * commit a new revision.
 *
 * ### Creating a Deployment
 * **Example:** Generated id
 * ```typescript
 * const deployment = yield* GCP.Apigeeregistry.ApisDeployment("Staging", {
 *   api: api.name,
 *   displayName: "staging",
 *   endpointUri: "https://pets.example.com",
 * });
 * ```
 *
 * **Example:** Named deployment
 * ```typescript
 * const deployment = yield* GCP.Apigeeregistry.ApisDeployment("Staging", {
 *   api: api.name,
 *   deploymentId: "staging",
 *   endpointUri: "https://pets.example.com",
 *   labels: { env: "test" },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Apigeeregistry
 */
export const ApisDeployment = Resource<ApisDeployment>(
  "GCP.Apigeeregistry.ApisDeployment",
);

const parentApi = (api: string, project: string, location: string) =>
  expandParent(api, project, location, "apis");

const resourceName = (api: string, deploymentId: string) =>
  `${api}/deployments/${deploymentId}`;

const toAttrs = (deployment: registry.ApiDeployment, project: string) => {
  const name = deployment.name ?? "";
  const parsed = parseResourceName(name, "deployments");
  return {
    name,
    deploymentId: parsed.id,
    api: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    displayName: deployment.displayName,
    description: deployment.description,
    endpointUri: deployment.endpointUri,
    apiSpecRevision: deployment.apiSpecRevision,
    intendedAudience: deployment.intendedAudience,
    externalChannelUri: deployment.externalChannelUri,
    accessGuidance: deployment.accessGuidance,
    revisionId: deployment.revisionId,
    labels: userLabels(deployment.labels),
    annotations: annotationsOf(deployment.annotations),
    createTime: deployment.createTime,
    revisionCreateTime: deployment.revisionCreateTime,
    revisionUpdateTime: deployment.revisionUpdateTime,
  };
};

const getByName = missingGet(registry.getProjectsLocationsApisDeployments);

export const ApisDeploymentProvider = () =>
  Provider.succeed(ApisDeployment, {
    stables: [
      "name",
      "deploymentId",
      "api",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      return replaceOnIdentity({
        previousId: olds?.deploymentId ?? output?.deploymentId,
        nextId: news.deploymentId,
        previousLocation: normalizeLocation(olds?.location ?? output?.location),
        nextLocation: location,
        previousParent: olds?.api ?? output?.api,
        nextParent: parentApi(news.api, env.project, location),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const deploymentId = yield* toPhysicalId(
        id,
        olds?.deploymentId,
        output?.deploymentId,
      );
      const api =
        olds?.api !== undefined
          ? parentApi(olds.api, env.project, location)
          : (output?.api ?? "");
      const name = output?.name ?? (api ? resourceName(api, deploymentId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const apis = yield* listApis(
          locationParent(env.project, DEFAULT_LOCATION),
        );
        const deployments = yield* listChildResources(
          namedOf(apis),
          listDeployments,
        );
        return deployments
          .filter((item) => hasAlchemyLabelMap(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const api = parentApi(news.api, env.project, location);
      const deploymentId = yield* toPhysicalId(
        id,
        news.deploymentId,
        output?.deploymentId,
      );
      const name = output?.name ?? resourceName(api, deploymentId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = tagRecord(news.annotations);
      const displayName = news.displayName ?? deploymentId;
      const body: registry.ApiDeployment = {
        displayName,
        description: news.description,
        endpointUri: news.endpointUri,
        apiSpecRevision: news.apiSpecRevision,
        intendedAudience: news.intendedAudience,
        externalChannelUri: news.externalChannelUri,
        accessGuidance: news.accessGuidance,
        labels: desiredLabels,
        annotations: desiredAnnotations,
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          registry.createProjectsLocationsApisDeployments({
            parent: api,
            apiDeploymentId: deploymentId,
            body,
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new RegistryNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = !sameText(
        current.description,
        news.description,
      );
      const endpointChanged = !sameText(current.endpointUri, news.endpointUri);
      const specChanged = !sameText(
        current.apiSpecRevision,
        news.apiSpecRevision,
      );
      const audienceChanged = !sameText(
        current.intendedAudience,
        news.intendedAudience,
      );
      const channelChanged = !sameText(
        current.externalChannelUri,
        news.externalChannelUri,
      );
      const guidanceChanged = !sameText(
        current.accessGuidance,
        news.accessGuidance,
      );
      const annotationsChanged = !sameJson(
        annotationsOf(current.annotations),
        desiredAnnotations,
      );

      if (
        labelsChanged ||
        displayChanged ||
        descriptionChanged ||
        endpointChanged ||
        specChanged ||
        audienceChanged ||
        channelChanged ||
        guidanceChanged ||
        annotationsChanged
      ) {
        current = yield* retryTransient(
          registry.patchProjectsLocationsApisDeployments({
            name: currentName,
            updateMask: updateMaskOf(
              displayChanged ? "displayName" : undefined,
              descriptionChanged ? "description" : undefined,
              endpointChanged ? "endpointUri" : undefined,
              specChanged ? "apiSpecRevision" : undefined,
              audienceChanged ? "intendedAudience" : undefined,
              channelChanged ? "externalChannelUri" : undefined,
              guidanceChanged ? "accessGuidance" : undefined,
              labelsChanged ? "labels" : undefined,
              annotationsChanged ? "annotations" : undefined,
            ),
            body: { name: currentName, ...body },
          }),
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreGone(
        registry.deleteProjectsLocationsApisDeployments({
          name: output.name,
          force: true,
        }),
      );
    }),
  });
