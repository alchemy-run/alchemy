import * as applications from "@distilled.cloud/microsoft-graph/applications";
import { Unowned } from "alchemy/AdoptPolicy";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { waitForProvisioned } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  ALCHEMY_TAG_FILTER,
  deleteAndPurge,
  desiredGraphTags,
  hasAnyAlchemyGraphTag,
  idTagFilter,
  isOwnedGraph,
  orUndefinedIfGone,
  readRecorded,
  REPLICATION_LAG,
  sameGraphTags,
  userGraphTags,
} from "./internal.ts";

/** Which accounts may sign in to the application. */
export type SignInAudience =
  | "AzureADMyOrg"
  | "AzureADMultipleOrgs"
  | "AzureADandPersonalMicrosoftAccount"
  | "PersonalMicrosoftAccount";

/** A permission the application requests on another API. */
export interface RequiredResourceAccess {
  /** Client (app) ID of the API, e.g. `00000003-0000-0000-c000-000000000000` for Microsoft Graph. */
  resourceAppId: string;
  /** Permissions requested on that API. */
  resourceAccess: {
    /** ID of the delegated scope or app role. */
    id: string;
    /** `Scope` for a delegated permission, `Role` for an application permission. */
    type: "Scope" | "Role";
  }[];
}

export interface ApplicationProps {
  /**
   * Display name shown in the Entra admin center (1-256 characters). Names
   * are not unique. If omitted, a name is generated from the app, stage,
   * and logical ID.
   */
  displayName?: string;
  /** Free-text description (up to 1,024 characters). */
  description?: string;
  /** Notes for the people who manage the application. */
  notes?: string;
  /**
   * Accounts that may sign in.
   * @default "AzureADMyOrg"
   */
  signInAudience?: SignInAudience;
  /**
   * App ID URIs (`api://...`) when the application exposes an API. They
   * must be unique in the tenant.
   * @default []
   */
  identifierUris?: string[];
  /** Web platform settings: redirect URIs for the authorization-code flow. */
  web?: {
    redirectUris?: string[];
    homePageUrl?: string;
    logoutUrl?: string;
  };
  /** Single-page application redirect URIs (authorization code with PKCE). */
  spa?: {
    redirectUris?: string[];
  };
  /** Mobile and desktop redirect URIs. */
  publicClient?: {
    redirectUris?: string[];
  };
  /**
   * API permissions the application requests. Granting admin consent for
   * them is a separate step.
   * @default []
   */
  requiredResourceAccess?: RequiredResourceAccess[];
  /**
   * User tags (plain strings). Alchemy adds its ownership tags
   * (`alchemy::stack=<stack>`, `alchemy::stage=<stage>`, `alchemy::id=<id>`).
   */
  tags?: string[];
}

export interface Application extends Resource<
  "Azure.Entra.Application",
  ApplicationProps,
  {
    /** Object ID of the application in the directory. Pass it to `ApplicationPassword` and `FederatedIdentityCredential`. */
    objectId: string;
    /** Application (client) ID that clients sign in with. */
    appId: string;
    /** Entra tenant (directory) ID that holds the application. */
    tenantId: string;
    /** Display name. */
    displayName: string;
    /** Accounts that may sign in. */
    signInAudience: string;
    /** User tags (Alchemy ownership tags removed). */
    tags: string[];
  },
  never,
  Providers
> {}

/**
 * A Microsoft Entra ID application registration: the identity a program
 * signs in as. Pair it with an `Azure.Entra.ServicePrincipal` to give it
 * Azure RBAC roles, and an `Azure.Entra.ApplicationPassword` or
 * `Azure.Entra.FederatedIdentityCredential` so it can get tokens.
 *
 * Applications have no resource group: they live in the tenant. Alchemy
 * records ownership in the application's `tags` (a list of strings) as
 * `alchemy::stack=<stack>`, `alchemy::stage=<stage>` and
 * `alchemy::id=<id>`. Destroy deletes the application and then purges it
 * from the directory's deleted items, so it does not count toward the
 * tenant's object quota for 30 days.
 *
 * The deploying service principal needs the Microsoft Graph application
 * permission `Application.ReadWrite.OwnedBy` (or
 * `Application.ReadWrite.All`).
 *
 * @see https://learn.microsoft.com/graph/api/resources/application
 *
 * ### Registering an Application
 * **Example:** An application other clouds sign in as
 * ```typescript
 * const app = yield* Azure.Entra.Application("Ci");
 * const principal = yield* Azure.Entra.ServicePrincipal("CiPrincipal", {
 *   appId: app.appId,
 * });
 * ```
 *
 * **Example:** A web application with redirect URIs
 * ```typescript
 * const app = yield* Azure.Entra.Application("Portal", {
 *   displayName: "Customer portal",
 *   web: { redirectUris: ["https://portal.example.com/auth/callback"] },
 *   tags: ["team:portal"],
 * });
 * ```
 *
 * ### Requesting API Permissions
 * **Example:** Request Microsoft Graph `User.Read`
 * ```typescript
 * const app = yield* Azure.Entra.Application("Reader", {
 *   requiredResourceAccess: [
 *     {
 *       resourceAppId: "00000003-0000-0000-c000-000000000000",
 *       resourceAccess: [{ id: "e1fe6dd8-ba31-4d61-89e7-88639da4683d", type: "Scope" }],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const Application = Resource<Application>("Azure.Entra.Application");

type ObservedApplication = applications.GetApplicationResponse;

const getApplication = (objectId: string) =>
  orUndefinedIfGone(applications.getApplication({ applicationId: objectId }));

/** An application recorded in state (tolerates replication lag). */
const getRecorded = (objectId: string) =>
  readRecorded(applications.getApplication({ applicationId: objectId }));

/** The application tagged with this logical id for this stack and stage. */
const findOwned = (id: string) =>
  Effect.gen(function* () {
    const page = yield* applications.listApplication({ filter: idTagFilter(id) });
    for (const app of page.value) {
      if (yield* isOwnedGraph(id, app.tags)) return app;
    }
    return undefined;
  });

const createDisplayName = (id: string) => createPhysicalName({ id, maxLength: 120 });

/** The Graph fields Alchemy manages, as the desired value of each. */
const desiredFields = (news: ApplicationProps, displayName: string, tags: string[]) => ({
  displayName,
  description: news.description ?? null,
  notes: news.notes ?? null,
  signInAudience: news.signInAudience ?? "AzureADMyOrg",
  identifierUris: news.identifierUris ?? [],
  web: {
    redirectUris: news.web?.redirectUris ?? [],
    homePageUrl: news.web?.homePageUrl ?? null,
    logoutUrl: news.web?.logoutUrl ?? null,
  },
  spa: { redirectUris: news.spa?.redirectUris ?? [] },
  publicClient: { redirectUris: news.publicClient?.redirectUris ?? [] },
  requiredResourceAccess: (news.requiredResourceAccess ?? []).map((r) => ({
    resourceAppId: r.resourceAppId,
    resourceAccess: r.resourceAccess.map((a) => ({ id: a.id, type: a.type })),
  })),
  tags,
});

type DesiredFields = ReturnType<typeof desiredFields>;

/** The observed value of each managed field, shaped like {@link desiredFields}. */
const observedFields = (app: ObservedApplication): DesiredFields => ({
  displayName: app.displayName ?? "",
  description: app.description ?? null,
  notes: app.notes ?? null,
  signInAudience: app.signInAudience ?? "AzureADMyOrg",
  identifierUris: app.identifierUris ?? [],
  web: {
    redirectUris: app.web?.redirectUris ?? [],
    homePageUrl: app.web?.homePageUrl ?? null,
    logoutUrl: app.web?.logoutUrl ?? null,
  },
  spa: { redirectUris: app.spa?.redirectUris ?? [] },
  publicClient: { redirectUris: app.publicClient?.redirectUris ?? [] },
  requiredResourceAccess: (app.requiredResourceAccess ?? []).map((r) => ({
    resourceAppId: r.resourceAppId ?? "",
    resourceAccess: (r.resourceAccess ?? []).map((a) => ({
      id: a.id ?? "",
      type: (a.type ?? "Scope") as "Scope" | "Role",
    })),
  })),
  tags: app.tags ?? [],
});

/** The managed fields whose observed value differs from the desired one. */
const delta = (observed: DesiredFields, desired: DesiredFields): Partial<DesiredFields> => {
  const changed: Record<string, unknown> = {};
  for (const key of Object.keys(desired) as (keyof DesiredFields)[]) {
    const same =
      key === "tags"
        ? sameGraphTags(observed.tags, desired.tags)
        : JSON.stringify(observed[key]) === JSON.stringify(desired[key]);
    if (!same) changed[key] = desired[key];
  }
  return changed as Partial<DesiredFields>;
};

const toAttrs = (tenantId: string, app: ObservedApplication): Application["Attributes"] => ({
  objectId: app.id ?? "",
  appId: app.appId ?? "",
  tenantId,
  displayName: app.displayName ?? "",
  signInAudience: app.signInAudience ?? "AzureADMyOrg",
  tags: userGraphTags(app.tags),
});

export const ApplicationProvider = () =>
  Provider.succeed(Application, {
    stables: ["objectId", "appId", "tenantId"],

    list: Effect.fn(function* () {
      const { tenantId } = yield* AzureEnvironment.current;
      const apps = yield* Stream.runCollect(
        applications.listApplication.items({
          filter: ALCHEMY_TAG_FILTER,
          consistencyLevel: "eventual",
          count: true,
        }),
      );
      return [...apps]
        .filter((app) => hasAnyAlchemyGraphTag(app.tags))
        .map((app) => toAttrs(tenantId, app));
    }),

    read: Effect.fn(function* ({ id, output }) {
      const { tenantId } = yield* AzureEnvironment.current;
      const observed =
        output?.objectId !== undefined ? yield* getRecorded(output.objectId) : yield* findOwned(id);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(tenantId, observed);
      return (yield* isOwnedGraph(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news = {}, output }) {
      const { tenantId } = yield* AzureEnvironment.current;
      const displayName = news.displayName ?? output?.displayName ?? (yield* createDisplayName(id));
      const tags = yield* desiredGraphTags(id, news.tags);
      const desired = desiredFields(news, displayName, tags);

      // Observe: by object ID, else by the ownership tags (a create whose
      // state write was lost).
      let observed =
        output?.objectId !== undefined ? yield* getRecorded(output.objectId) : undefined;
      observed ??= yield* findOwned(id);

      // Ensure.
      if (observed === undefined) {
        const created = yield* applications.createApplication(desired);
        observed = yield* waitForProvisioned(
          `application ${displayName}`,
          getApplication(created.id!),
          () => undefined,
          { interval: "2 seconds", times: 15 },
        );
      }

      // Sync the managed fields against the observed application.
      const changed = delta(observedFields(observed), desired);
      if (Object.keys(changed).length > 0) {
        const objectId = observed.id!;
        yield* applications
          .updateApplication({ applicationId: objectId, ...changed })
          .pipe(Effect.retry(REPLICATION_LAG));
        observed = { ...observed, ...changed };
      }
      return toAttrs(tenantId, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      // A 404 right after create can be lag; only a settled 404 is "gone".
      if ((yield* getRecorded(output.objectId)) === undefined) return;
      yield* deleteAndPurge({
        name: `application ${output.displayName}`,
        objectId: output.objectId,
        get: getApplication(output.objectId),
        remove: applications.deleteApplication({ applicationId: output.objectId }),
      });
    }),
  });
