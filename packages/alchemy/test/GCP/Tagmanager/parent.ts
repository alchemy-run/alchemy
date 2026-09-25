import * as tagmanager from "@distilled.cloud/gcp/tagmanager_v2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const collect = <Page, Item, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly Item[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const listAccounts = () =>
  collect(tagmanager.listAccounts.pages({}), (page) => page.account);

export const requireAccountPath = () =>
  Effect.gen(function* () {
    const accounts = yield* listAccounts();
    const account = accounts.find(
      (row) => (row.path ?? row.accountId) !== undefined,
    );
    const path =
      account?.path ??
      (account?.accountId !== undefined
        ? `accounts/${account.accountId}`
        : undefined);
    if (path === undefined) {
      return yield* Effect.fail(
        new tagmanager.NotFound({
          message: "no GTM account is visible to these credentials",
        }),
      );
    }
    return path;
  });

export const listContainers = (parent: string) =>
  collect(
    tagmanager.listAccountsContainers.pages({ parent }),
    (page) => page.container,
  );

export const listWorkspaces = (parent: string) =>
  collect(
    tagmanager.listAccountsContainersWorkspaces.pages({ parent }),
    (page) => page.workspace,
  );

export type GtmParents = {
  accountPath: string;
  containerPath: string;
  workspacePath: string;
  publicId: string | undefined;
};

const containerPathOf = (
  accountPath: string,
  container: tagmanager.Container,
) =>
  container.path ??
  (container.containerId !== undefined
    ? `${accountPath}/containers/${container.containerId}`
    : undefined);

const workspacePathOf = (
  containerPath: string,
  workspace: tagmanager.Workspace,
) =>
  workspace.path ??
  (workspace.workspaceId !== undefined
    ? `${containerPath}/workspaces/${workspace.workspaceId}`
    : undefined);

export const ensureParents = (
  containerName: string,
  usageContext: "web" | "server",
) =>
  Effect.gen(function* () {
    const accountPath = yield* requireAccountPath();
    const containers = yield* listContainers(accountPath);
    let container = containers.find((row) => row.name === containerName);
    if (container === undefined) {
      container = yield* tagmanager.createAccountsContainers({
        parent: accountPath,
        body: {
          name: containerName,
          usageContext: [usageContext],
          notes: "alchemy-tagmanager-2",
        },
      });
    }
    const containerPath = containerPathOf(accountPath, container);
    if (containerPath === undefined) {
      return yield* Effect.fail(
        new tagmanager.NotFound({
          message: `container ${containerName} has no path`,
        }),
      );
    }
    const workspaces = yield* listWorkspaces(containerPath);
    let workspace = workspaces[0];
    if (workspace === undefined) {
      workspace = yield* tagmanager.createAccountsContainersWorkspaces({
        parent: containerPath,
        body: {
          name: `${containerName}-ws`,
          description: "alchemy-tagmanager-2",
        },
      });
    }
    const workspacePath = workspacePathOf(containerPath, workspace);
    if (workspacePath === undefined) {
      return yield* Effect.fail(
        new tagmanager.NotFound({
          message: `workspace for ${containerName} has no path`,
        }),
      );
    }
    return {
      accountPath,
      containerPath,
      workspacePath,
      publicId: container.publicId,
    } satisfies GtmParents;
  });

export const deleteContainer = (path: string) =>
  tagmanager.deleteAccountsContainers({ path }).pipe(
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.catchTag("Forbidden", () => Effect.void),
    Effect.catchTag("Conflict", () => Effect.void),
  );
