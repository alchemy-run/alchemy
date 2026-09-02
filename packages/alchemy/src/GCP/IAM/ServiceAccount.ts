import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const OWNERSHIP_KEYS = [
  "alchemy-stack",
  "alchemy-stage",
  "alchemy-id",
] as const;

export type ServiceAccountProps = {
  /** Project that owns the account. Defaults to the current GCP project. */
  project?: string;
  /**
   * Account id used as the email prefix. It must be 6-30 lowercase letters,
   * digits, or hyphens. Changing it replaces the account.
   */
  accountId?: string;
  /** Human-readable display name (maximum 100 UTF-8 bytes). */
  displayName?: string;
  /**
   * Human-readable description. Service accounts have no labels, so Alchemy
   * ownership (`alchemy-stack` / `alchemy-stage` / `alchemy-id`) is stored
   * on the first line of the description for `list` / nuke; the marker and
   * this text share the API's 256-byte limit.
   */
  description?: string;
};

export type ServiceAccount = Resource<
  "GCP.IAM.ServiceAccount",
  ServiceAccountProps,
  {
    /** Full resource name. */
    name: string;
    /** Project that owns the account. */
    project: string;
    /** Stable account id (the email prefix). */
    accountId: string;
    /** Service-account email address. */
    email: string;
    /** Globally unique numeric id. */
    uniqueId: string | undefined;
    /** OAuth 2 client id. */
    oauth2ClientId: string | undefined;
    /** Human-readable display name. */
    displayName: string | undefined;
    /** User description (Alchemy ownership marker stripped). */
    description: string | undefined;
    /** Whether the account is disabled. */
    disabled: boolean | undefined;
  },
  never,
  Providers
>;

/**
 * A user-managed Google Cloud IAM service account.
 *
 * ### Creating a Service Account
 * **Example:** Service account with a generated id
 * ```typescript
 * const account = yield* GCP.IAM.ServiceAccount("Worker", {
 *   displayName: "Background worker",
 * });
 * ```
 *
 * **Example:** Service account with an explicit id
 * ```typescript
 * const account = yield* GCP.IAM.ServiceAccount("GkeNodes", {
 *   accountId: "prod-gke-nodes",
 *   displayName: "Production GKE nodes",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category IAM
 */
export const ServiceAccount = Resource<ServiceAccount>(
  "GCP.IAM.ServiceAccount",
);

export class ServiceAccountNotResolved extends Data.TaggedError(
  "GCP.IAM.ServiceAccountNotResolved",
)<{ name: string }> {}

const accountIdFromEmail = (email: string) => email.split("@")[0] ?? email;
const emailOf = (project: string, accountId: string) =>
  `${accountId}@${project}.iam.gserviceaccount.com`;
const nameOf = (project: string, accountId: string) =>
  `projects/${project}/serviceAccounts/${emailOf(project, accountId)}`;

const encodeDescription = (
  internal: Record<string, string>,
  user?: string,
): string => {
  const marker = OWNERSHIP_KEYS.map(
    (key) => `${key}=${internal[key] ?? ""}`,
  ).join(" ");
  return user && user.length > 0 ? `${marker}\n${user}` : marker;
};

const parseDescription = (description: string | undefined) => {
  if (!description) {
    return { labels: {} as Record<string, string>, description: undefined };
  }
  const newline = description.indexOf("\n");
  const first = newline === -1 ? description : description.slice(0, newline);
  const rest = newline === -1 ? undefined : description.slice(newline + 1);
  if (!first.includes("alchemy-id=") || !first.includes("alchemy-stack=")) {
    return { labels: {} as Record<string, string>, description };
  }
  const labels: Record<string, string> = {};
  for (const part of first.split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  return {
    labels,
    description: rest && rest.length > 0 ? rest : undefined,
  };
};

const hasAlchemyMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const toAttrs = (account: iam.ServiceAccount, project: string) => {
  const email = account.email ?? "";
  return {
    name: account.name ?? nameOf(project, accountIdFromEmail(email)),
    project: account.projectId ?? project,
    accountId: accountIdFromEmail(email),
    email,
    uniqueId: account.uniqueId,
    oauth2ClientId: account.oauth2ClientId,
    displayName: account.displayName,
    description: parseDescription(account.description).description,
    disabled: account.disabled,
  };
};

const getByName = (name: string) =>
  iam
    .getProjectsServiceAccounts({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toAccountId = (id: string, requested?: string, existing?: string) =>
  Effect.gen(function* () {
    return (
      requested ??
      existing ??
      (yield* createPhysicalName({
        id,
        prefix: `alchemy-${id}-`,
        maxLength: 30,
        lowercase: true,
      }))
    );
  });

export const ServiceAccountProvider = () =>
  Provider.succeed(ServiceAccount, {
    stables: ["name", "project", "accountId", "email", "uniqueId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const oldProject = olds?.project ?? output?.project ?? env.project;
      if (
        (news.project !== undefined && news.project !== oldProject) ||
        (news.accountId !== undefined &&
          news.accountId !== (olds?.accountId ?? output?.accountId))
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const project = olds?.project ?? output?.project ?? env.project;
      const accountId = yield* toAccountId(
        id,
        olds?.accountId,
        output?.accountId,
      );
      const existing = yield* getByName(
        output?.name ?? nameOf(project, accountId),
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, project);
      const parsed = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, parsed.labels))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* iam.listProjectsServiceAccounts
          .pages({ name: `projects/${env.project}`, pageSize: 100 })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          (page.accounts ?? [])
            .filter((account) => hasAlchemyMarker(account.description))
            .map((account) => toAttrs(account, env.project)),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const project = news.project ?? output?.project ?? env.project;
      const accountId = yield* toAccountId(
        id,
        news.accountId,
        output?.accountId,
      );
      const name = output?.name ?? nameOf(project, accountId);
      const internal = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(internal, news.description);
      let current = yield* getByName(name);

      if (current === undefined) {
        current = yield* iam
          .createProjectsServiceAccounts({
            name: `projects/${project}`,
            body: {
              accountId,
              serviceAccount: {
                displayName: news.displayName,
                description: desiredDescription,
              },
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
      }
      if (current === undefined) {
        return yield* new ServiceAccountNotResolved({ name });
      }

      const updateMask = [
        (current.displayName ?? "") !== (news.displayName ?? "")
          ? "displayName"
          : undefined,
        (current.description ?? "") !== desiredDescription
          ? "description"
          : undefined,
      ].filter((field): field is string => field !== undefined);
      if (updateMask.length > 0) {
        yield* iam.patchProjectsServiceAccounts({
          name: current.name ?? name,
          body: {
            updateMask: updateMask.join(","),
            serviceAccount: {
              displayName: news.displayName ?? "",
              description: desiredDescription,
            },
          },
        });
        // The patch response only echoes the masked fields; re-read so the
        // attributes carry uniqueId and the rest of the account.
        current = (yield* getByName(current.name ?? name)) ?? current;
      }
      return toAttrs(current, project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* iam
        .deleteProjectsServiceAccounts({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
