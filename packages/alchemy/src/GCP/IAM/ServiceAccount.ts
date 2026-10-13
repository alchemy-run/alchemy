import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { alchemyLabelKeys, createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const ACCOUNT_ID_MAX = 30;
const DESCRIPTION_MAX = 256;

export type ServiceAccountProps = {
  /** Project that owns the account. Defaults to the current GCP project. */
  project?: string;
  /**
   * Account id used as the email prefix: 6-30 lowercase letters, digits,
   * or hyphens. If omitted, a unique id is generated. Changing it
   * replaces the account.
   */
  accountId?: string;
  /** Human-readable display name (maximum 100 UTF-8 bytes). */
  displayName?: string;
  /**
   * Human-readable description. Service accounts have no labels, so
   * Alchemy stamps ownership into a `[alchemy …]` prefix and strips it
   * from the `description` attribute. The marker and this text share the
   * API's 256-byte limit; overflow is truncated.
   */
  description?: string;
};

export type ServiceAccount = Resource<
  "GCP.IAM.ServiceAccount",
  ServiceAccountProps,
  {
    /** Full resource name `projects/{project}/serviceAccounts/{email}`. */
    name: string;
    /** Project that owns the account. */
    project: string;
    /** Account id (the email prefix). */
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
 * Grant it roles with `GCP.IAM.Member` (`kind: "project"` for project-wide
 * roles), and pass its `email` to resources that run as an identity, such
 * as GKE node pools or Compute instances.
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
 * ### Granting Roles
 * **Example:** Let the account write logs in the project
 * ```typescript
 * const account = yield* GCP.IAM.ServiceAccount("Worker", {});
 * yield* GCP.IAM.Member("WorkerLogs", {
 *   kind: "project",
 *   name: account.project,
 *   role: "roles/logging.logWriter",
 *   member: Output.interpolate`serviceAccount:${account.email}`,
 * });
 * ```
 *
 * @resource
 * @category IAM
 */
export const ServiceAccount = Resource<ServiceAccount>("GCP.IAM.ServiceAccount");

export class ServiceAccountNotResolved extends Data.TaggedError(
  "GCP.IAM.ServiceAccountNotResolved",
)<{ name: string }> {}

const accountIdFromEmail = (email: string) => email.split("@")[0] ?? email;
const emailOf = (project: string, accountId: string) =>
  `${accountId}@${project}.iam.gserviceaccount.com`;
const nameOf = (project: string, accountId: string) =>
  `projects/${project}/serviceAccounts/${emailOf(project, accountId)}`;

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  if (!description) return marker.slice(0, DESCRIPTION_MAX);
  const sep = "\n";
  const budget = DESCRIPTION_MAX - marker.length - sep.length;
  if (budget <= 0) return marker.slice(0, DESCRIPTION_MAX);
  return `${marker}${sep}${description.slice(0, budget)}`;
};

const parseDescription = (
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

const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) => key.startsWith("alchemy-"));

const toAttrs = (account: iam.ServiceAccount, project: string): ServiceAccount["Attributes"] => {
  const email = account.email ?? "";
  const accountId = accountIdFromEmail(email);
  return {
    name: account.name ?? nameOf(project, accountId),
    project: account.projectId ?? project,
    accountId,
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

const toAccountId = (id: string, explicit: string | undefined, existing: string | undefined) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    return yield* createPhysicalName({
      id,
      prefix: `alchemy-${id}-`,
      maxLength: ACCOUNT_ID_MAX,
      lowercase: true,
    });
  });

export const ServiceAccountProvider = () =>
  Provider.succeed(ServiceAccount, {
    stables: ["name", "project", "accountId", "email", "uniqueId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousProject = olds?.project ?? output?.project ?? env.project;
      const previousAccountId = olds?.accountId ?? output?.accountId;
      if (
        (news.project !== undefined && news.project !== previousProject) ||
        (news.accountId !== undefined && news.accountId !== previousAccountId)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const project = olds?.project ?? output?.project ?? env.project;
      const accountId = yield* toAccountId(id, olds?.accountId, output?.accountId);
      const existing = yield* getByName(output?.name ?? nameOf(project, accountId));
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* iam.listProjectsServiceAccounts
          .pages({
            name: `projects/${env.project}`,
            pageSize: 100,
          })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.accounts ?? [])),
            Stream.filter((account) => hasOwnershipMarker(account.description)),
            Stream.map((account) => toAttrs(account, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([] as ServiceAccount["Attributes"][])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const project = news.project ?? output?.project ?? env.project;
      const accountId = yield* toAccountId(id, news.accountId, output?.accountId);
      const name = output?.name ?? nameOf(project, accountId);
      const internal = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(internal, news.description);

      // Observe
      let current = yield* getByName(name);

      // Ensure — `Conflict` is a create race; adopt the winner.
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
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "ServiceAccountQuotaExceeded",
              times: 6,
              schedule: Schedule.exponential("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => getByName(name)),
          );
      }
      if (current === undefined) {
        return yield* new ServiceAccountNotResolved({ name });
      }
      // A new account is eventually consistent: reads (and IAM bindings that
      // name it) fail with NotFound for a few seconds after create.
      current = yield* getByName(current.name ?? name).pipe(
        Effect.flatMap((account) =>
          account === undefined
            ? Effect.fail(new ServiceAccountNotResolved({ name }))
            : Effect.succeed(account),
        ),
        Effect.retry({
          while: (error) => error._tag === "GCP.IAM.ServiceAccountNotResolved",
          schedule: Schedule.exponential("500 millis"),
          times: 8,
        }),
      );

      // Sync display name and description against observed state.
      const updateMask = [
        (current.displayName ?? "") !== (news.displayName ?? "") ? "displayName" : undefined,
        (current.description ?? "") !== desiredDescription ? "description" : undefined,
      ].filter((field): field is string => field !== undefined);
      if (updateMask.length > 0) {
        const patched = yield* iam.patchProjectsServiceAccounts({
          name: current.name ?? name,
          body: {
            updateMask: updateMask.join(","),
            serviceAccount: {
              displayName: news.displayName ?? "",
              description: desiredDescription,
            },
          },
        });
        // The patch response only echoes the masked fields, and a re-read can
        // still return the previous values, so the patched fields win.
        current = {
          ...current,
          displayName: patched.displayName ?? news.displayName,
          description: patched.description ?? desiredDescription,
        };
      }
      return toAttrs(current, project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* iam
        .deleteProjectsServiceAccounts({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
