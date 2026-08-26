import * as script from "@distilled.cloud/gcp/script_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeDescription,
  ensureVersionNumber,
  findOwnedDeployment,
  getDeployment,
  hasOwnershipMarker,
  listOwnedDeployments,
  ownedByAlchemy,
  ownershipLabels,
  parseDescription,
  sameText,
} from "./internal.ts";

export type DeploymentProps = {
  /**
   * Apps Script project Drive id (`scriptId`). Required — deployments
   * belong to a script project created with `projects.create`.
   * Immutable — changing it replaces the deployment.
   */
  scriptId: string;
  /**
   * Server-assigned deployment id. Omit on create; pass the observed
   * id to update in place. Immutable — changing it replaces the
   * deployment.
   */
  deploymentId?: string;
  /**
   * Script version this deployment pins. When omitted, Alchemy uses the
   * latest existing version or creates one from HEAD.
   */
  versionNumber?: number;
  /**
   * Human-readable description. Deployments have no labels field, so
   * Alchemy stamps ownership into a `[alchemy …]` prefix and strips it
   * from attributes.
   */
  description?: string;
  /**
   * Manifest file name for this deployment. Defaults to `appsscript`.
   */
  manifestFileName?: string;
};

export type Deployment = Resource<
  "GCP.Script.Deployment",
  DeploymentProps,
  {
    /** Server-assigned deployment id. */
    deploymentId: string;
    /** Parent Apps Script project Drive id. */
    scriptId: string;
    /** Project id used when the deployment was reconciled. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Pinned script version number. */
    versionNumber: number | undefined;
    /** Manifest file name. */
    manifestFileName: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Entry points advertised by this deployment. */
    entryPoints: script.EntryPoint[] | undefined;
  },
  never,
  Providers
>;

/**
 * An Apps Script API deployment of a script project.
 *
 * Deployments have no labels — Alchemy stamps ownership into
 * `deploymentConfig.description` for `list` / nuke. `scriptId` and
 * `deploymentId` are identity; changing either replaces the deployment.
 * Version, description, and manifest file name update in place.
 *
 * Creating deployments as a service account requires the Apps Script
 * API (`script.googleapis.com`) plus a user OAuth token or domain-wide
 * delegation (`script.projects` / `script.deployments` scopes).
 *
 * ### Creating a Deployment
 * **Example:** Pin version 1 of an existing script
 * ```typescript
 * const deployment = yield* GCP.Script.Deployment("Api", {
 *   scriptId: "1abcScriptId",
 *   versionNumber: 1,
 * });
 * ```
 *
 * **Example:** Named description
 * ```typescript
 * const deployment = yield* GCP.Script.Deployment("Api", {
 *   scriptId: "1abcScriptId",
 *   versionNumber: 1,
 *   description: "production",
 * });
 * ```
 *
 * ### Updating a Deployment
 * **Example:** Move to a newer version
 * ```typescript
 * const deployment = yield* GCP.Script.Deployment("Api", {
 *   scriptId: existing.scriptId,
 *   deploymentId: existing.deploymentId,
 *   versionNumber: 2,
 *   description: "production v2",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Script
 */
export const Deployment = Resource<Deployment>("GCP.Script.Deployment");

export class DeploymentNotResolved extends Data.TaggedError(
  "GCP.Script.DeploymentNotResolved",
)<{
  scriptId: string;
  deploymentId: string;
}> {}

const toAttrs = (
  deployment: script.Deployment,
  project: string,
  scriptId: string,
) => {
  const config = deployment.deploymentConfig;
  return {
    deploymentId: deployment.deploymentId ?? "",
    scriptId: config?.scriptId ?? scriptId,
    project,
    description: parseDescription(config?.description).description,
    versionNumber: config?.versionNumber,
    manifestFileName: config?.manifestFileName,
    updateTime: deployment.updateTime,
    entryPoints: deployment.entryPoints,
  };
};

const userDescription = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined) return requested;
    if (existing !== undefined) return existing;
    return yield* createPhysicalName({
      id,
      maxLength: 40,
      lowercase: true,
    });
  });

export const DeploymentProvider = () =>
  Provider.succeed(Deployment, {
    stables: ["deploymentId", "scriptId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousScript = olds?.scriptId ?? output?.scriptId;
      if (previousScript !== undefined && news.scriptId !== previousScript) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousId = olds?.deploymentId ?? output?.deploymentId;
      if (
        previousId !== undefined &&
        news.deploymentId !== undefined &&
        news.deploymentId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const scriptId = olds?.scriptId ?? output?.scriptId ?? "";
      const deploymentId = olds?.deploymentId ?? output?.deploymentId ?? "";
      let existing = yield* getDeployment(scriptId, deploymentId);
      if (existing === undefined) {
        existing = yield* findOwnedDeployment(id, scriptId);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(
        existing,
        env.project,
        existing.deploymentConfig?.scriptId ?? scriptId,
      );
      return (yield* ownedByAlchemy(id, existing.deploymentConfig?.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const deployments = yield* listOwnedDeployments();
        return deployments
          .filter((deployment) =>
            hasOwnershipMarker(deployment.deploymentConfig?.description),
          )
          .map((deployment) =>
            toAttrs(
              deployment,
              env.project,
              deployment.deploymentConfig?.scriptId ?? "",
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const scriptId = news.scriptId;
      const labels = yield* ownershipLabels(id);
      const description = yield* userDescription(
        id,
        news.description,
        output?.description,
      );
      const desiredDescription = encodeDescription(labels, description);

      let current = yield* getDeployment(
        scriptId,
        news.deploymentId ?? output?.deploymentId ?? "",
      );
      if (current === undefined) {
        current = yield* findOwnedDeployment(id, scriptId);
      }

      const versionNumber = yield* ensureVersionNumber(
        scriptId,
        news.versionNumber ??
          current?.deploymentConfig?.versionNumber ??
          output?.versionNumber,
      );
      const manifestFileName =
        news.manifestFileName ?? current?.deploymentConfig?.manifestFileName;

      const config: script.DeploymentConfig = {
        scriptId,
        description: desiredDescription,
        versionNumber,
        manifestFileName,
      };

      if (current === undefined) {
        const created = yield* script
          .createProjectsDeployments({
            scriptId,
            body: config,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwnedDeployment(id, scriptId),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined || !current.deploymentId) {
        return yield* new DeploymentNotResolved({
          scriptId,
          deploymentId: news.deploymentId ?? output?.deploymentId ?? "",
        });
      }

      const observed = current.deploymentConfig;
      const versionChanged =
        versionNumber !== undefined &&
        (observed?.versionNumber ?? undefined) !== versionNumber;
      const descriptionChanged = !sameText(
        observed?.description,
        desiredDescription,
      );
      const manifestChanged =
        manifestFileName !== undefined &&
        (observed?.manifestFileName ?? "") !== manifestFileName;

      if (versionChanged || descriptionChanged || manifestChanged) {
        current = yield* script.updateProjectsDeployments({
          scriptId,
          deploymentId: current.deploymentId,
          body: { deploymentConfig: config },
        });
      }

      return toAttrs(current, env.project, scriptId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.scriptId || !output.deploymentId) return;
      yield* script
        .deleteProjectsDeployments({
          scriptId: output.scriptId,
          deploymentId: output.deploymentId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
