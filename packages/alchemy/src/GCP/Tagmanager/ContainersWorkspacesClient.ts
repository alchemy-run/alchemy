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
  encodeOwnership,
  resolveWorkspace,
  hasOwnershipMarker,
  internalLabels,
  lastSegment,
  listClientsAt,
  ownedByAlchemy,
  parametersOf,
  parseOwnership,
  parsePath,
  retryConflict,
  sameJson,
  sameNumber,
  sameText,
  TagmanagerNotResolved,
  toDisplayName,
  type Parameter,
} from "./internal.ts";

export type ClientParameter = Parameter;

export type ContainersWorkspacesClientProps = {
  /**
   * Parent workspace path
   * (`accounts/{account}/containers/{container}/workspaces/{workspace}`)
   * or workspace id when `container` is also set. Immutable — changing
   * it replaces the client.
   */
  workspace: string;
  /**
   * Parent container path used when `workspace` is an id. Immutable —
   * changing it replaces the client.
   */
  container?: string;
  /**
   * GTM client id. Server-assigned when omitted. Immutable — changing it
   * replaces the client.
   */
  clientId?: string;
  /**
   * Client type (`gaaw`, `html`, …). Required.
   */
  type: string;
  /**
   * Client display name. Generated when omitted.
   */
  name?: string;
  /**
   * Client notes. Alchemy stamps ownership here and strips it from
   * attributes.
   */
  notes?: string;
  /**
   * Client parameters.
   */
  parameter?: ClientParameter[];
  /**
   * Relative firing order. Higher values fire first.
   */
  priority?: number;
  /**
   * Parent folder id.
   */
  parentFolderId?: string;
};

export type ContainersWorkspacesClient = Resource<
  "GCP.Tagmanager.ContainersWorkspacesClient",
  ContainersWorkspacesClientProps,
  {
    /** GTM API path `.../workspaces/{workspace}/clients/{client}`. */
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
    /** GTM client id. */
    clientId: string;
    /** Client type. */
    type: string | undefined;
    /** User display name. */
    name: string | undefined;
    /** User notes with the Alchemy ownership prefix stripped. */
    notes: string | undefined;
    /** Client parameters. */
    parameter: ClientParameter[] | undefined;
    /** Firing priority. */
    priority: number | undefined;
    /** Parent folder id. */
    parentFolderId: string | undefined;
    /** Tag Manager UI URL. */
    tagManagerUrl: string | undefined;
    /** Storage fingerprint used for optimistic updates. */
    fingerprint: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Tag Manager client (server-side containers only).
 *
 * Clients run in server containers (`usageContext: ["server"]`). Alchemy
 * stamps ownership into `notes` so `list` / nuke can find them. Parent
 * workspace and id are immutable. Type, name, notes, parameters,
 * priority, and folder update in place.
 *
 * ### Creating a Client
 * **Example:** GA4 client
 * ```typescript
 * const client = yield* GCP.Tagmanager.ContainersWorkspacesClient("Ga4", {
 *   workspace: workspace.path,
 *   type: "gaaw",
 *   name: "ga4",
 *   parameter: [
 *     { type: "template", key: "measurementId", value: "G-TEST000000" },
 *   ],
 * });
 * ```
 *
 * ### Updating a Client
 * **Example:** Raise priority
 * ```typescript
 * const client = yield* GCP.Tagmanager.ContainersWorkspacesClient("Ga4", {
 *   workspace: existing.workspace,
 *   clientId: existing.clientId,
 *   type: "gaaw",
 *   name: "ga4",
 *   priority: 10,
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Tagmanager
 */
export const ContainersWorkspacesClient = Resource<ContainersWorkspacesClient>(
  "GCP.Tagmanager.ContainersWorkspacesClient",
);

export class ContainersWorkspacesClientNotResolved extends Data.TaggedError(
  "GCP.Tagmanager.ContainersWorkspacesClientNotResolved",
)<{
  path: string;
}> {}

const toAttrs = (client: tagmanager.Client, workspaceHint?: string) => {
  const path = client.path ?? "";
  const parsed = parsePath(path);
  return {
    path,
    workspace: parsed.workspace || workspaceHint || "",
    container: parsed.container,
    account: parsed.account,
    accountId: client.accountId ?? parsed.accountId ?? "",
    containerId: client.containerId ?? parsed.containerId ?? "",
    workspaceId: client.workspaceId ?? parsed.workspaceId ?? "",
    clientId: client.clientId ?? parsed.clientId ?? lastSegment(path),
    type: client.type,
    name: client.name,
    notes: parseOwnership(client.notes).text,
    parameter: parametersOf(client.parameter),
    priority: client.priority,
    parentFolderId: client.parentFolderId,
    tagManagerUrl: client.tagManagerUrl,
    fingerprint: client.fingerprint,
  };
};

const getByPath = (path: string) =>
  path.length === 0
    ? Effect.succeed(undefined)
    : tagmanager
        .getAccountsContainersWorkspacesClients({ path })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (
  workspace: string,
  id: string,
  name: string | undefined,
  notes: string | undefined,
) =>
  listClientsAt(workspace).pipe(
    Effect.flatMap((clients) =>
      Effect.gen(function* () {
        for (const client of clients) {
          if (notes !== undefined && client.notes === notes) return client;
          if (
            name !== undefined &&
            client.name === name &&
            (yield* ownedByAlchemy(id, client.notes))
          ) {
            return client;
          }
          if (yield* ownedByAlchemy(id, client.notes)) return client;
        }
        return undefined;
      }),
    ),
  );

export const ContainersWorkspacesClientProvider = () =>
  Provider.succeed(ContainersWorkspacesClient, {
    stables: [
      "path",
      "workspace",
      "container",
      "account",
      "accountId",
      "containerId",
      "workspaceId",
      "clientId",
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
      const previousId = olds?.clientId ?? output?.clientId;
      if (
        previousId !== undefined &&
        news.clientId !== undefined &&
        news.clientId !== previousId
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
        (olds?.clientId && workspace
          ? `${workspace}/clients/${olds.clientId}`
          : "");
      let existing = yield* getByPath(path);
      if (existing === undefined && workspace.length > 0) {
        existing = yield* findOwned(workspace, id, olds?.name, undefined);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, workspace);
      return (yield* ownedByAlchemy(id, existing.notes))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      eachWorkspace((workspace) =>
        listClientsAt(workspace).pipe(
          Effect.map((clients) =>
            clients
              .filter((client) => hasOwnershipMarker(client.notes))
              .map((client) => toAttrs(client, workspace)),
          ),
        ),
      ),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const workspace = resolveWorkspace(news.workspace, news.container);
      const path =
        output?.path ??
        (news.clientId ? `${workspace}/clients/${news.clientId}` : "");
      const ownership = yield* internalLabels(id);
      const name = yield* toDisplayName(id, news.name, output?.name);
      const notes = encodeOwnership(ownership, news.notes);
      const body: tagmanager.Client = {
        type: news.type,
        name,
        notes,
        parameter: news.parameter,
        priority: news.priority,
        parentFolderId: news.parentFolderId,
      };

      let current = yield* getByPath(output?.path ?? path);
      if (current === undefined) {
        current = yield* findOwned(workspace, id, name, notes);
      }

      if (current === undefined) {
        const created = yield* tagmanager
          .createAccountsContainersWorkspacesClients({
            parent: workspace,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(workspace, id, name, notes),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ContainersWorkspacesClientNotResolved({
          path: path || `${workspace}/clients/-`,
        });
      }

      if (!(yield* ownedByAlchemy(id, current.notes))) {
        return yield* new TagmanagerNotResolved({
          path: current.path ?? path,
        });
      }

      const currentPath = current.path ?? path;
      const changed =
        !sameText(current.type, news.type) ||
        !sameText(current.name, name) ||
        !sameText(current.notes, notes) ||
        !sameJson(parametersOf(current.parameter), news.parameter) ||
        !sameNumber(current.priority, news.priority) ||
        !sameText(current.parentFolderId, news.parentFolderId);

      if (changed) {
        const updated = yield* retryConflict(
          Effect.gen(function* () {
            const fresh = yield* getByPath(currentPath);
            if (fresh === undefined) return undefined;
            return yield* tagmanager.updateAccountsContainersWorkspacesClients({
              path: currentPath,
              fingerprint: fresh.fingerprint,
              body: {
                ...body,
                path: currentPath,
                accountId: fresh.accountId,
                containerId: fresh.containerId,
                workspaceId: fresh.workspaceId,
                clientId: fresh.clientId,
              },
            });
          }),
        );
        current = updated ?? current;
      }

      return toAttrs(current, workspace);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* tagmanager
        .deleteAccountsContainersWorkspacesClients({ path: output.path })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
