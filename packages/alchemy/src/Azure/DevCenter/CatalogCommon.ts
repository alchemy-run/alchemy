import type * as devcenter from "@distilled.cloud/azure/devcenter";
import * as Schedule from "effect/Schedule";
import { userTags } from "../Arm.ts";
import { sameValue } from "./Common.ts";

/** A Git repository folder that a dev center or project catalog syncs. */
export interface CatalogGitSource {
  /** Clone URI of the repository, e.g. `https://github.com/org/repo.git`. */
  uri: string;
  /** Branch to sync. */
  branch?: string;
  /** Folder within the repository that holds the catalog items. */
  path?: string;
  /**
   * Key Vault secret URI holding a personal access token for the
   * repository. The dev center (or project) identity needs
   * `Key Vault Secrets User` on the vault. Omit for public repositories.
   */
  secretIdentifier?: string;
}

export type CatalogSyncType = "Manual" | "Scheduled";

/** Props shared by dev center and project catalogs. */
export interface CatalogSourceProps {
  /**
   * GitHub repository source. Exactly one of `gitHub` / `adoGit` is set;
   * switching between them replaces the catalog.
   */
  gitHub?: CatalogGitSource;
  /** Azure DevOps Git repository source. */
  adoGit?: CatalogGitSource;
  /**
   * Whether the catalog syncs only on demand or on a schedule.
   * @default Azure's default (`Manual`)
   */
  syncType?: CatalogSyncType;
  /**
   * User tags (stored in the catalog's `properties.tags`). Alchemy
   * ownership tags are merged in automatically.
   */
  tags?: Record<string, string>;
}

/** Attributes shared by dev center and project catalogs. */
export interface CatalogSourceAttributes {
  /** Name of the catalog. */
  catalogName: string;
  /** ARM resource ID of the catalog. */
  catalogId: string;
  /** Resource group of the parent. */
  resourceGroup: string;
  /** `gitHub` or `adoGit`. */
  sourceType: "gitHub" | "adoGit";
  /** Repository clone URI. */
  uri: string | undefined;
  /** Synced branch. */
  branch: string | undefined;
  /** Synced folder. */
  path: string | undefined;
  /** Sync type (`Manual` or `Scheduled`). */
  syncType: string | undefined;
  /** State of the last sync (`Succeeded`, `InProgress`, `Failed`, ...). */
  syncState: string | undefined;
  /** Whether the catalog can reach its repository (`Connected`/`Disconnected`). */
  connectionState: string | undefined;
  /** Time of the last sync. */
  lastSyncTime: string | undefined;
  /** User tags (Alchemy ownership tags stripped). */
  tags: Record<string, string>;
}

type ObservedCatalog = devcenter.GetCatalogResponse;

export const sourceTypeOf = (props: CatalogSourceProps) =>
  props.adoGit !== undefined ? ("adoGit" as const) : ("gitHub" as const);

export const toGitCatalog = (
  source: CatalogGitSource | undefined,
): devcenter.GitCatalog | undefined =>
  source === undefined
    ? undefined
    : {
        uri: source.uri,
        branch: source.branch,
        path: source.path,
        secretIdentifier: source.secretIdentifier,
      };

export const toCatalogAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedCatalog,
): CatalogSourceAttributes => {
  const props = observed.properties;
  const sourceType = props?.adoGit !== undefined ? "adoGit" : "gitHub";
  const git = props?.adoGit ?? props?.gitHub;
  return {
    catalogName: name,
    catalogId: observed.id ?? "",
    resourceGroup,
    sourceType,
    uri: git?.uri,
    branch: git?.branch,
    path: git?.path,
    syncType: props?.syncType,
    syncState: props?.syncState,
    connectionState: props?.connectionState,
    lastSyncTime: props?.lastSyncTime,
    tags: userTags(props?.tags),
  };
};

/**
 * Compute the PATCH body for the observed catalog, or `undefined` when it
 * already matches the desired state.
 */
export const catalogDelta = (
  observed: ObservedCatalog,
  news: CatalogSourceProps,
  tags: Record<string, string>,
  tagsChanged: boolean,
): devcenter.CatalogUpdateProperties | undefined => {
  const props = observed.properties;
  const delta: devcenter.CatalogUpdateProperties = {};
  const sourceType = sourceTypeOf(news);
  const desiredGit = toGitCatalog(news[sourceType]);
  const observedGit = props?.[sourceType];
  if (
    desiredGit !== undefined &&
    !sameValue(
      {
        uri: observedGit?.uri,
        branch: observedGit?.branch,
        path: observedGit?.path,
        secretIdentifier: observedGit?.secretIdentifier,
      },
      desiredGit,
    )
  ) {
    delta[sourceType] = desiredGit;
  }
  if (news.syncType !== undefined && props?.syncType !== news.syncType) {
    delta.syncType = news.syncType;
  }
  if (tagsChanged) delta.tags = tags;
  return Object.keys(delta).length > 0 ? delta : undefined;
};

/** Catalog writes conflict while a sync or a previous write is running. */
export const whileCatalogBusy = {
  while: (e: { readonly _tag: string }) => e._tag === "ResourceConflict",
  schedule: Schedule.spaced("10 seconds"),
  times: 18,
} as const;
