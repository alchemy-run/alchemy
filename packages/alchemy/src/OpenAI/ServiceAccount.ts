import * as OpenAI from "@distilled.cloud/openai";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

/** Role of a service account inside its project. */
export type ServiceAccountRole = "member" | "owner";

export interface ServiceAccountProps {
  /** ID of the project the service account belongs to. Changing it replaces the service account. */
  projectId: string;
  /**
   * Display name of the service account. Mutable. If omitted, a unique name is
   * generated from the app, stage and logical ID.
   */
  name?: string;
  /**
   * Project role of the service account. Mutable.
   * @default "member"
   */
  role?: ServiceAccountRole;
}

export interface ServiceAccountAttributes {
  /** ID of the owning project. */
  projectId: string;
  /** The service account ID. */
  serviceAccountId: string;
  /** Observed display name. */
  name: string;
  /** Observed project role (`owner`, `member`, or `none`). */
  role: string;
  /** Unix timestamp (seconds) of creation. */
  createdAt: number;
  /** ID of the API key held in {@link apiKey}. */
  apiKeyId: string;
  /**
   * The service account's API key. OpenAI reveals a key's value exactly once,
   * when it is created, so Alchemy keeps it in state (encrypted at rest when
   * the state store encrypts secrets). Pass it to Workers/Functions as a
   * secret, e.g. `OPENAI_API_KEY: bot.apiKey`.
   */
  apiKey: Redacted.Redacted<string>;
}

export interface ServiceAccount extends Resource<
  "OpenAI.ServiceAccount",
  ServiceAccountProps,
  ServiceAccountAttributes,
  never,
  Providers
> {}

/**
 * A service account inside an OpenAI project — a non-human identity with its
 * own API key, for applications and CI.
 *
 * Managed through the Admin API, so it requires an Admin key
 * (`OPENAI_ADMIN_KEY`, `sk-admin-…`).
 *
 * The API key value is only returned when it is created, so it is captured into
 * Alchemy state as a `Redacted` output (`apiKey`). Keep your state store
 * secure. If the recorded key is no longer present on the account (revoked out
 * of band) or its value is not in state (e.g. after adoption), the next deploy
 * mints a fresh key for the same service account rather than failing; earlier
 * keys of a service account cannot be deleted individually and are revoked when
 * the service account is deleted.
 *
 * ### Issuing an API Key
 * **Example:** Service account with a generated name
 * ```typescript
 * const project = yield* OpenAI.Project("App");
 * const bot = yield* OpenAI.ServiceAccount("Bot", {
 *   projectId: project.projectId,
 * });
 * ```
 *
 * **Example:** Pass the key to a Worker as a secret
 * ```typescript
 * const bot = yield* OpenAI.ServiceAccount("Bot", {
 *   projectId: project.projectId,
 * });
 * const worker = yield* Cloudflare.Worker("Api", {
 *   main: "./src/worker.ts",
 *   env: { OPENAI_API_KEY: bot.apiKey },
 * });
 * ```
 *
 * ### Roles
 * **Example:** Project owner service account
 * ```typescript
 * const admin = yield* OpenAI.ServiceAccount("Admin", {
 *   projectId: project.projectId,
 *   role: "owner",
 * });
 * ```
 *
 * @resource
 * @product OpenAI
 * @category AI
 */
export const ServiceAccount = Resource<ServiceAccount>("OpenAI.ServiceAccount");

const accountName = (id: string, name: string | undefined) =>
  name !== undefined ? Effect.succeed(name) : createPhysicalName({ id, maxLength: 64 });

/** Whether the project still exists and is not archived. */
const projectIsLive = (projectId: string) =>
  OpenAI.projects.getProject({ project_id: projectId }).pipe(
    Effect.map(
      (project) => project.status !== "archived" && (project.archived_at ?? null) === null,
    ),
    Effect.catchTag("ProjectNotFound", () => Effect.succeed(false)),
  );

const getAccount = (projectId: string, serviceAccountId: string) =>
  OpenAI.projects
    .getProjectServiceAccount({ project_id: projectId, service_account_id: serviceAccountId })
    .pipe(
      Effect.catchTag(["ServiceAccountNotFound", "ProjectNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const findAccountsByName = (projectId: string, name: string) =>
  OpenAI.projects.listProjectServiceAccounts.items({ project_id: projectId, limit: 100 }).pipe(
    Stream.filter((account) => account.name === name),
    Stream.runCollect,
    Effect.map((accounts) => Array.from(accounts)),
  );

/** Whether the recorded key is still an active key of the project. */
const keyExists = (projectId: string, apiKeyId: string) =>
  OpenAI.projects.getProjectApiKey({ project_id: projectId, api_key_id: apiKeyId }).pipe(
    Effect.as(true),
    Effect.catchTag(["ProjectApiKeyNotFound", "ProjectNotFound"], () => Effect.succeed(false)),
  );

/** The SDK delivers key values as `Redacted`; the `string` arm only exists in its type. */
const redact = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? value : Redacted.make(value);

export const ServiceAccountProvider = () =>
  Provider.succeed(ServiceAccount, {
    stables: ["projectId", "serviceAccountId", "createdAt"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      if (!isResolved(news)) return undefined;
      if (news.projectId !== (output?.projectId ?? olds.projectId)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      if (output?.serviceAccountId) {
        const account = yield* getAccount(output.projectId, output.serviceAccountId);
        if (account === undefined) return undefined;
        return {
          ...output,
          name: account.name,
          role: account.role,
          createdAt: account.created_at,
        };
      }
      if (olds?.projectId === undefined) return undefined;
      const name = yield* accountName(id, olds.name);
      const [match, ...rest] = yield* findAccountsByName(olds.projectId, name);
      if (match === undefined || rest.length > 0) return undefined;
      // The key value cannot be recovered; reconcile mints one after adoption.
      return Unowned({
        projectId: olds.projectId,
        serviceAccountId: match.id,
        name: match.name,
        role: match.role,
        createdAt: match.created_at,
        apiKeyId: "",
        apiKey: redact(""),
      } satisfies ServiceAccountAttributes);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = news.name ?? output?.name ?? (yield* accountName(id, undefined));
      const projectId = news.projectId;

      // 1. Observe the recorded service account (missing → recreate).
      const observed =
        output?.serviceAccountId && output.projectId === projectId
          ? yield* getAccount(projectId, output.serviceAccountId)
          : undefined;

      let serviceAccountId: string;
      let createdAt: number;
      let role: string;
      let observedName: string;
      let apiKeyId = output?.apiKeyId ?? "";
      let apiKey = output?.apiKey;

      if (observed === undefined) {
        // 2. Ensure — the create response is the only time the key value is
        // revealed, so never auto-retry it (a retry could orphan a key).
        const created = yield* OpenAI.projects
          .createProjectServiceAccount({ project_id: projectId, name })
          .pipe(OpenAI.Retry.none);
        serviceAccountId = created.id;
        createdAt = created.created_at;
        role = created.role;
        observedName = created.name;
        if (created.api_key !== null) {
          apiKeyId = created.api_key.id;
          apiKey = redact(created.api_key.value);
        } else {
          apiKeyId = "";
          apiKey = undefined;
        }
      } else {
        serviceAccountId = observed.id;
        createdAt = observed.created_at;
        role = observed.role;
        observedName = observed.name;
      }

      // 3a. Sync the key: keep the cached secret while its key still exists;
      // otherwise (adoption, out-of-band revocation) mint a replacement.
      const haveSecret =
        apiKey !== undefined && Redacted.value(apiKey).length > 0 && apiKeyId.length > 0;
      if (!haveSecret || !(yield* keyExists(projectId, apiKeyId))) {
        const minted = yield* OpenAI.projects
          .createServiceAccountApiKey({
            project_id: projectId,
            service_account_id: serviceAccountId,
            name,
          })
          .pipe(OpenAI.Retry.none);
        apiKeyId = minted.id;
        apiKey = redact(minted.value);
      }

      // 3b. Sync name/role against the observed account.
      const desiredRole = news.role ?? (role === "owner" ? "owner" : "member");
      if (observedName !== name || role !== desiredRole) {
        const updated = yield* OpenAI.projects.updateProjectServiceAccount({
          project_id: projectId,
          service_account_id: serviceAccountId,
          ...(observedName !== name ? { name } : {}),
          ...(role !== desiredRole ? { role: desiredRole } : {}),
        });
        observedName = updated.name;
        role = updated.role;
      }

      return {
        projectId,
        serviceAccountId,
        name: observedName,
        role,
        createdAt,
        apiKeyId,
        // Always defined here: a missing secret was minted in step 3a.
        apiKey: apiKey ?? redact(""),
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      // Archived projects have no service accounts — and reject the delete.
      if (!(yield* projectIsLive(output.projectId))) return;
      yield* OpenAI.projects
        .deleteProjectServiceAccount({
          project_id: output.projectId,
          service_account_id: output.serviceAccountId,
        })
        .pipe(Effect.catchTag(["ServiceAccountNotFound", "ProjectNotFound"], () => Effect.void));
    }),
  });
