import * as drive from "@distilled.cloud/gcp/drive_v3";
import * as script from "@distilled.cloud/gcp/script_v1";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const SCRIPT_MIME_TYPE = "application/vnd.google-apps.script";
export const SCRIPT_FILE_QUERY = `mimeType='${SCRIPT_MIME_TYPE}' and trashed=false`;

export const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

export const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const ownedByAlchemy = (id: string, description: string | undefined) =>
  Effect.gen(function* () {
    const { labels } = parseDescription(description);
    return yield* hasAlchemyLabels(id, labels);
  });

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const getDeployment = (scriptId: string, deploymentId: string) =>
  scriptId.length === 0 || deploymentId.length === 0
    ? Effect.succeed(undefined)
    : script
        .getProjectsDeployments({ scriptId, deploymentId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listDeployments = (scriptId: string) =>
  scriptId.length === 0
    ? Effect.succeed([] as script.Deployment[])
    : script.listProjectsDeployments.pages({ scriptId, pageSize: 100 }).pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.deployments ?? [])),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("NotFound", () =>
          Effect.succeed([] as script.Deployment[]),
        ),
        Effect.catchTag("Forbidden", () =>
          Effect.succeed([] as script.Deployment[]),
        ),
      );

export const listVersions = (scriptId: string) =>
  scriptId.length === 0
    ? Effect.succeed([] as script.Version[])
    : script.listProjectsVersions.pages({ scriptId, pageSize: 100 }).pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.versions ?? [])),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("NotFound", () =>
          Effect.succeed([] as script.Version[]),
        ),
        Effect.catchTag("Forbidden", () =>
          Effect.succeed([] as script.Version[]),
        ),
      );

export const listScriptFiles = () =>
  drive.listFiles
    .pages({
      q: SCRIPT_FILE_QUERY,
      pageSize: 100,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.files ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([] as drive.File[])),
      Effect.catchTag("Forbidden", () => Effect.succeed([] as drive.File[])),
    );

export const findOwnedDeployment = (id: string, scriptId: string | undefined) =>
  Effect.gen(function* () {
    const scriptIds =
      scriptId && scriptId.length > 0
        ? [scriptId]
        : (yield* listScriptFiles())
            .map((file) => file.id)
            .filter((value): value is string => !!value && value.length > 0);
    for (const candidate of scriptIds) {
      const deployments = yield* listDeployments(candidate);
      for (const deployment of deployments) {
        if (
          yield* ownedByAlchemy(id, deployment.deploymentConfig?.description)
        ) {
          return deployment;
        }
      }
    }
    return undefined;
  });

export const listOwnedDeployments = () =>
  Effect.gen(function* () {
    const files = yield* listScriptFiles();
    const pages = yield* Effect.forEach(
      files,
      (file) =>
        file.id
          ? listDeployments(file.id)
          : Effect.succeed([] as script.Deployment[]),
      { concurrency: 4 },
    );
    return pages
      .flat()
      .filter((deployment) =>
        hasOwnershipMarker(deployment.deploymentConfig?.description),
      );
  });

export const latestVersionNumber = (scriptId: string) =>
  Effect.gen(function* () {
    const versions = yield* listVersions(scriptId);
    let max = 0;
    for (const version of versions) {
      const number = version.versionNumber ?? 0;
      if (number > max) max = number;
    }
    return max > 0 ? max : undefined;
  });

export const ensureVersionNumber = (
  scriptId: string,
  requested: number | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined) return requested;
    const existing = yield* latestVersionNumber(scriptId);
    if (existing !== undefined) return existing;
    const created = yield* script
      .createProjectsVersions({
        scriptId,
        body: { description: "alchemy" },
      })
      .pipe(
        Effect.catchTag("Conflict", () =>
          Effect.succeed(undefined as script.Version | undefined),
        ),
      );
    return created?.versionNumber ?? (yield* latestVersionNumber(scriptId));
  });
