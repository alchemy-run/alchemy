import * as tagmanager from "@distilled.cloud/gcp/tagmanager_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_DISPLAY_NAME_LENGTH = 256;
export const MAX_NOTES_LENGTH = 8000;
export const ALCHEMY_EMAIL_PREFIX = "alc.";

export class TagmanagerAccountNotFound extends Data.TaggedError(
  "GCP.Tagmanager.AccountNotFound",
)<{
  message: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -2).join("/");
};

export const collectionParent = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const index = parts.lastIndexOf(collection);
  if (index < 0 || parts[index + 1] === undefined) return parentOf(name);
  return parts.slice(0, index + 2).join("/");
};

export const expandAccount = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  if (trimmed.startsWith("accounts/")) {
    const parts = trimmed.split("/").filter((part) => part.length > 0);
    const index = parts.indexOf("accounts");
    if (index >= 0 && parts[index + 1] !== undefined) {
      return `accounts/${parts[index + 1]}`;
    }
  }
  return `accounts/${lastSegment(trimmed)}`;
};

export const expandWorkspace = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/").filter((part) => part.length > 0);
  const index = parts.lastIndexOf("workspaces");
  if (index >= 0 && parts[index + 1] !== undefined) {
    return parts.slice(0, index + 2).join("/");
  }
  return trimmed;
};

export const accountPathOf = (path: string) => {
  const parts = path.split("/").filter((part) => part.length > 0);
  const index = parts.indexOf("accounts");
  if (index >= 0 && parts[index + 1] !== undefined) {
    return `accounts/${parts[index + 1]}`;
  }
  return "";
};

export const workspacePathOf = (path: string) => expandWorkspace(path);

export const resourcePath = (parent: string, collection: string, id: string) =>
  `${parent}/${collection}/${id}`;

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length === 0 ? undefined : value;
  }
  if (Array.isArray(value)) {
    const items = value.map(canonical).filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, canonical(item)] as const)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries);
  }
  return undefined;
};

export const fingerprint = (value: unknown): string =>
  JSON.stringify(canonical(value) ?? null);

export const sameJson = (left: unknown, right: unknown) =>
  fingerprint(left) === fingerprint(right);

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  fingerprint([...(left ?? [])].slice().sort()) ===
  fingerprint([...(right ?? [])].slice().sort());

export const toDisplayName = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return yield* createPhysicalName({
      id,
      maxLength: 200,
      lowercase: true,
    });
  });

export const toGeneratedEmail = (id: string, explicit: string | undefined) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    const local = yield* createPhysicalName({
      id,
      maxLength: 40,
      lowercase: true,
    });
    return `${ALCHEMY_EMAIL_PREFIX}${local.replace(/[^a-z0-9]/g, "")}@example.com`;
  });

export const isAlchemyEmail = (email: string | undefined) => {
  const value = (email ?? "").trim().toLowerCase();
  return value.startsWith(ALCHEMY_EMAIL_PREFIX) || value.startsWith("alchemy-");
};

const markerOf = (
  labels: Record<string, string>,
  stack: string,
  stage: string,
  id: string,
) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const shrinkMarker = (
  labels: Record<string, string>,
  maxLength: number,
  build: (stack: string, stage: string, id: string) => string,
) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = build(stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (stack.length >= stage.length && stack.length >= id.length) {
      stack = stack.slice(0, -1);
    } else if (stage.length >= id.length) {
      stage = stage.slice(0, -1);
    } else {
      id = id.slice(0, -1);
    }
    marker = build(stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

const fitMarker = (labels: Record<string, string>, maxLength: number) =>
  shrinkMarker(labels, maxLength, (stack, stage, id) =>
    markerOf(labels, stack, stage, id),
  );

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
): string => {
  const marker = fitMarker(labels, MAX_NOTES_LENGTH);
  const trimmed = text?.trim();
  return trimmed && trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_DISPLAY_NAME_LENGTH,
): string => {
  const trimmed = text?.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return fitMarker(labels, maxLength);
  const minMarker = 24;
  const reserved = Math.min(
    trimmed.length + 1,
    Math.max(0, maxLength - minMarker),
  );
  const marker = fitMarker(labels, maxLength - reserved);
  return `${marker} ${trimmed}`.slice(0, maxLength);
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!text?.startsWith("[alchemy ")) {
    return { labels: {}, text };
  }
  const end = text.indexOf("]");
  if (end < 0) return { labels: {}, text };
  const labels: Record<string, string> = {};
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseOwnership(text);
    if (!hasOwnershipMarker(text)) return false;
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
    return (
      prefixMatch(
        expected[alchemyLabelKeys.stack] ?? "",
        labels[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.stage] ?? "",
        labels[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.id] ?? "",
        labels[alchemyLabelKeys.id] ?? "",
      )
    );
  });

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const isOwnedEntity = (entity: { name?: string; notes?: string }) =>
  hasOwnershipMarker(entity.notes) || hasOwnershipMarker(entity.name);

export type TagmanagerParameter = {
  /** Parameter type (`template`, `integer`, `boolean`, `list`, `map`, …). */
  type?: string;
  /** Named key. Required for top-level and map values. */
  key?: string;
  /** Scalar value. */
  value?: string;
  /** Nested map parameters. */
  map?: TagmanagerParameter[];
  /** Nested list parameters. */
  list?: TagmanagerParameter[];
  /** Weak reference. Used by transformations. */
  isWeakReference?: boolean;
};

export type TagmanagerCondition = {
  /** Operator (`equals`, `contains`, `startsWith`, `matchRegex`, …). */
  type?: string;
  /** Named operands (`arg0`, `arg1`, `ignore_case`, `negate`, …). */
  parameter?: TagmanagerParameter[];
};

export const parametersOf = (
  list:
    | readonly tagmanager.Parameter[]
    | readonly TagmanagerParameter[]
    | undefined,
): TagmanagerParameter[] | undefined => {
  if (list === undefined) return undefined;
  return list.map((parameter) => ({
    type: parameter.type,
    key: parameter.key,
    value: parameter.value,
    map: parametersOf(parameter.map),
    list: parametersOf(parameter.list),
    isWeakReference: parameter.isWeakReference,
  }));
};

export type Parameter = TagmanagerParameter;
export const internalLabels = ownershipLabels;
export const ALCHEMY_PARAM_KEY = "_alchemy";

export class TagmanagerNotResolved extends Data.TaggedError(
  "GCP.Tagmanager.ResourceNotResolved",
)<{
  path: string;
}> {}

export const parsePath = (path: string) => {
  const parts = path.split("/").filter((part) => part.length > 0);
  const at = (collection: string) => {
    const index = parts.lastIndexOf(collection);
    return index >= 0 ? parts[index + 1] : undefined;
  };
  const accountId = at("accounts");
  const containerId = at("containers");
  const workspaceId = at("workspaces");
  return {
    accountId,
    containerId,
    workspaceId,
    environmentId: at("environments"),
    clientId: at("clients"),
    folderId: at("folders"),
    gtagConfigId: at("gtag_config"),
    tagId: at("tags"),
    templateId: at("templates"),
    account: accountId !== undefined ? `accounts/${accountId}` : parentOf(path),
    container:
      accountId !== undefined && containerId !== undefined
        ? `accounts/${accountId}/containers/${containerId}`
        : collectionParent(path, "containers"),
    workspace:
      accountId !== undefined &&
      containerId !== undefined &&
      workspaceId !== undefined
        ? `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`
        : collectionParent(path, "workspaces"),
  };
};

export const expandContainer = (container: string, account?: string) => {
  if (container.includes("/containers/")) {
    return collectionParent(
      container.includes("/workspaces/") || container.includes("/environments/")
        ? container
        : `${container}/_/_`,
      "containers",
    );
  }
  if (account !== undefined) {
    return `${expandAccount(account)}/containers/${lastSegment(container)}`;
  }
  return container;
};

export const resolveWorkspace = (workspace: string, container?: string) => {
  if (workspace.includes("/workspaces/")) return expandWorkspace(workspace);
  if (container !== undefined) {
    return `${expandContainer(container)}/workspaces/${lastSegment(workspace)}`;
  }
  return workspace;
};

export const containerPath = (account: string, containerId: string) =>
  `${expandAccount(account)}/containers/${containerId}`;

export const workspacePath = (container: string, workspaceId: string) =>
  `${expandContainer(container)}/workspaces/${workspaceId}`;

export const sameBool = (
  left: boolean | undefined,
  right: boolean | undefined,
) => (left === true) === (right === true);

export const sameNumber = (
  left: number | undefined,
  right: number | undefined,
) => (left ?? 0) === (right ?? 0);

export const withOwnershipParameter = (
  labels: Record<string, string>,
  list: readonly TagmanagerParameter[] | undefined,
): TagmanagerParameter[] => {
  const marker = fitMarker(labels, MAX_DISPLAY_NAME_LENGTH);
  const rest = (list ?? []).filter(
    (parameter) => parameter.key !== ALCHEMY_PARAM_KEY,
  );
  return [{ type: "template", key: ALCHEMY_PARAM_KEY, value: marker }, ...rest];
};

export const stripOwnershipParameter = (
  list:
    | readonly tagmanager.Parameter[]
    | readonly TagmanagerParameter[]
    | undefined,
): {
  labels: Record<string, string>;
  parameter: TagmanagerParameter[] | undefined;
} => {
  const parameters = parametersOf(list) ?? [];
  const alchemy = parameters.find(
    (parameter) => parameter.key === ALCHEMY_PARAM_KEY,
  );
  const rest = parameters.filter(
    (parameter) => parameter.key !== ALCHEMY_PARAM_KEY,
  );
  return {
    labels: parseOwnership(alchemy?.value).labels,
    parameter: rest.length > 0 ? rest : undefined,
  };
};

export const ownershipFromParameters = (
  list:
    | readonly tagmanager.Parameter[]
    | readonly TagmanagerParameter[]
    | undefined,
) => {
  const alchemy = (list ?? []).find(
    (parameter) => parameter.key === ALCHEMY_PARAM_KEY,
  );
  return alchemy?.value;
};

export const conditionsOf = (
  list: readonly tagmanager.Condition[] | undefined,
): TagmanagerCondition[] | undefined => {
  if (list === undefined) return undefined;
  return list.map((condition) => ({
    type: condition.type,
    parameter: parametersOf(condition.parameter),
  }));
};

export const collectPages = <Page, Item, E extends { _tag: string }, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly Item[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound" as never, () => Effect.succeed([] as Item[])),
    Effect.catchTag("Forbidden" as never, () => Effect.succeed([] as Item[])),
  );

export const listAccountRows = () =>
  collectPages(tagmanager.listAccounts.pages({}), (page) => page.account);

export const accountPath = (account: tagmanager.Account) =>
  account.path ??
  (account.accountId !== undefined ? `accounts/${account.accountId}` : "");

export const listContainerRows = (parent: string) =>
  parent.length === 0
    ? Effect.succeed([] as tagmanager.Container[])
    : collectPages(
        tagmanager.listAccountsContainers.pages({ parent }),
        (page) => page.container,
      );

export const listWorkspaceRows = (parent: string) =>
  parent.length === 0
    ? Effect.succeed([] as tagmanager.Workspace[])
    : collectPages(
        tagmanager.listAccountsContainersWorkspaces.pages({ parent }),
        (page) => page.workspace,
      );

const workspacePathsForAccount = (account: tagmanager.Account) =>
  Effect.gen(function* () {
    const parent = accountPath(account);
    const containers = yield* listContainerRows(parent);
    const groups = yield* Effect.forEach(
      containers,
      (container) =>
        Effect.gen(function* () {
          const containerPath =
            container.path ??
            (container.containerId !== undefined
              ? `${parent}/containers/${container.containerId}`
              : "");
          const workspaces = yield* listWorkspaceRows(containerPath);
          return workspaces.flatMap((workspace) => {
            const path =
              workspace.path ??
              (workspace.workspaceId !== undefined
                ? `${containerPath}/workspaces/${workspace.workspaceId}`
                : "");
            return path.length > 0 ? [path] : [];
          });
        }),
      { concurrency: 4 },
    );
    return groups.flat();
  });

export const listWorkspacePaths = () =>
  Effect.gen(function* () {
    const accounts = yield* listAccountRows();
    const groups = yield* Effect.forEach(accounts, workspacePathsForAccount, {
      concurrency: 2,
    });
    return groups.flat();
  });

export const listAccountPaths = () =>
  listAccountRows().pipe(
    Effect.map((accounts) =>
      accounts.flatMap((account) => {
        const path = accountPath(account);
        return path.length > 0 ? [path] : [];
      }),
    ),
  );

export const retryConflict = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 6,
      schedule: Schedule.exponential("200 millis"),
    }),
  );

export const listContainersAt = listContainerRows;
export const listWorkspacesAt = listWorkspaceRows;

export const listEnvironmentsAt = (parent: string) =>
  parent.length === 0
    ? Effect.succeed([] as tagmanager.Environment[])
    : collectPages(
        tagmanager.listAccountsContainersEnvironments.pages({ parent }),
        (page) => page.environment,
      );

export const listClientsAt = (parent: string) =>
  parent.length === 0
    ? Effect.succeed([] as tagmanager.Client[])
    : collectPages(
        tagmanager.listAccountsContainersWorkspacesClients.pages({ parent }),
        (page) => page.client,
      );

export const listFoldersAt = (parent: string) =>
  parent.length === 0
    ? Effect.succeed([] as tagmanager.Folder[])
    : collectPages(
        tagmanager.listAccountsContainersWorkspacesFolders.pages({ parent }),
        (page) => page.folder,
      );

export const listGtagConfigsAt = (parent: string) =>
  parent.length === 0
    ? Effect.succeed([] as tagmanager.GtagConfig[])
    : collectPages(
        tagmanager.listAccountsContainersWorkspacesGtag_config.pages({
          parent,
        }),
        (page) => page.gtagConfig,
      );

export const listTagsAt = (parent: string) =>
  parent.length === 0
    ? Effect.succeed([] as tagmanager.Tag[])
    : collectPages(
        tagmanager.listAccountsContainersWorkspacesTags.pages({ parent }),
        (page) => page.tag,
      );

export const listTemplatesAt = (parent: string) =>
  parent.length === 0
    ? Effect.succeed([] as tagmanager.CustomTemplate[])
    : collectPages(
        tagmanager.listAccountsContainersWorkspacesTemplates.pages({ parent }),
        (page) => page.template,
      );

export const listContainerPaths = () =>
  listAccountRows().pipe(
    Effect.flatMap((accounts) =>
      Effect.forEach(
        accounts,
        (account) => {
          const parent = accountPath(account);
          if (parent.length === 0) return Effect.succeed([] as string[]);
          return listContainerRows(parent).pipe(
            Effect.map((containers) =>
              containers.flatMap((container) => {
                const path =
                  container.path ??
                  (container.containerId !== undefined
                    ? `${parent}/containers/${container.containerId}`
                    : "");
                return path.length > 0 ? [path] : [];
              }),
            ),
          );
        },
        { concurrency: 2 },
      ),
    ),
    Effect.map((groups) => groups.flat()),
  );

export const eachContainer = <A, E, R>(
  fn: (container: string) => Effect.Effect<readonly A[], E, R>,
) =>
  listContainerPaths().pipe(
    Effect.flatMap((paths) =>
      Effect.forEach(paths, fn, { concurrency: 4 }).pipe(
        Effect.map((groups) => groups.flat()),
      ),
    ),
  );

export const eachWorkspace = <A, E, R>(
  fn: (workspace: string) => Effect.Effect<readonly A[], E, R>,
) =>
  listWorkspacePaths().pipe(
    Effect.flatMap((paths) =>
      Effect.forEach(paths, fn, { concurrency: 4 }).pipe(
        Effect.map((groups) => groups.flat()),
      ),
    ),
  );
