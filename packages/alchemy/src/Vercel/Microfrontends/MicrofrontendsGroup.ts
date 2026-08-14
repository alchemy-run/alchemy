import * as microfrontends from "@distilled.cloud/vercel/microfrontends";
import * as projects from "@distilled.cloud/vercel/projects";
import * as teams from "@distilled.cloud/vercel/teams";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";

/** A member application of a microfrontends group. */
export interface MicrofrontendsApp {
  /** The id (`prj_…`) of the member project. */
  projectId: string;
  /**
   * The default route used for screenshots and preview links for the
   * project. Left unmanaged when omitted.
   */
  defaultRoute?: string;
}

/**
 * The group's update/delete endpoints are team-scoped
 * (`/v1/teams/{teamId}/microfrontends/{groupId}`) — managing a
 * microfrontends group requires a team scope (`VERCEL_TEAM_ID` or a
 * team-scoped login).
 */
export class MicrofrontendsTeamRequiredError extends Data.TaggedError(
  "Vercel.MicrofrontendsTeamRequiredError",
)<{
  readonly message: string;
}> {}

/**
 * A freshly created group did not appear in the team's group listing —
 * a platform fault (the listing is immediately consistent, live-verified),
 * not a race the reconciler can converge out of.
 */
export class MicrofrontendsGroupNotVisibleError extends Data.TaggedError(
  "Vercel.MicrofrontendsGroupNotVisibleError",
)<{
  readonly groupId: string;
}> {}

export interface MicrofrontendsGroupProps {
  /**
   * Name of the microfrontends group (its slug is derived from it). If
   * omitted, a unique name is generated from `${app}-${stage}-${id}`.
   * Renaming an existing group updates it in place.
   */
  name?: string;
  /**
   * The default application of the group — the project whose deployment
   * serves as the root of the microfrontend. Changing the default app's
   * project replaces the group.
   */
  defaultApp: MicrofrontendsApp;
  /**
   * The child applications of the group (default app excluded). Membership
   * is converged exactly: projects present on the group but absent from
   * this list have microfrontends disabled.
   *
   * @default []
   */
  applications?: MicrofrontendsApp[];
  /**
   * The fallback environment for the group: `"SAME_ENV"`, `"PRODUCTION"`,
   * or a custom environment slug from the default app. Left unmanaged when
   * omitted.
   */
  fallbackEnvironment?: string;
}

export type MicrofrontendsGroup = Resource<
  "Vercel.MicrofrontendsGroup",
  MicrofrontendsGroupProps,
  {
    /** The group id (`mfe_…`). */
    groupId: string;
    /** Name of the group. */
    name: string;
    /** URL-safe slug derived from the name. */
    slug: string;
    /** The group's fallback environment (e.g. `SAME_ENV`). */
    fallbackEnvironment: string | undefined;
    /** The id of the default application's project. */
    defaultAppProjectId: string;
    /** Ids of the child applications' projects (default app excluded). */
    applicationProjectIds: string[];
    /** Creation time in epoch milliseconds. */
    createdAt: number | undefined;
    /** Last update time in epoch milliseconds. */
    updatedAt: number | undefined;
  },
  never,
  Providers
>;

type MicrofrontendsGroupAttributes = MicrofrontendsGroup["Attributes"];

/**
 * A Vercel Microfrontends Group — stitches several projects into one
 * application under the default app's domain, with each child application
 * serving its own routes.
 *
 * :::caution
 * **Microfrontends is a paid Vercel add-on billed at a flat $250/month,
 * charged immediately when a group is created.** Deploying this resource
 * incurs that charge on your Vercel team; deleting the group does not
 * refund the current month. Live tests are gated behind
 * `VERCEL_TEST_MICROFRONTENDS=1` for exactly this reason.
 * :::
 *
 * @resource
 * @section Creating a group
 * @example A group with a default app and one child application
 * ```typescript
 * const shell = yield* Vercel.Project("Shell", {});
 * const docs = yield* Vercel.Project("Docs", {});
 * const group = yield* Vercel.MicrofrontendsGroup("Group", {
 *   defaultApp: { projectId: shell.projectId },
 *   applications: [{ projectId: docs.projectId, defaultRoute: "/docs" }],
 * });
 * ```
 *
 * @section Managing membership
 * @example Converge membership exactly
 * ```typescript
 * // Removing an entry from `applications` disables microfrontends for
 * // that project on the next deploy.
 * yield* Vercel.MicrofrontendsGroup("Group", {
 *   defaultApp: { projectId: shell.projectId },
 *   applications: [],
 * });
 * ```
 *
 * @see https://vercel.com/docs/microfrontends
 */
export const MicrofrontendsGroup = Resource<MicrofrontendsGroup>(
  "Vercel.MicrofrontendsGroup",
);

// Group names must be under 48 characters (live-verified: "Microfrontends
// group name must be less than 48 characters long").
const createGroupName = (id: string) =>
  createPhysicalName({ id, maxLength: 47 });

/**
 * Every microfrontends endpoint is team-scoped and — unlike most of the
 * API — does NOT infer the team from a team-scoped token (live-verified:
 * `createMicrofrontendsGroupWithApplications` rejects with "missing
 * required property teamId"). Resolve it: prefer the configured tenancy;
 * otherwise a team-scoped token lists exactly its own team.
 */
const requiredTeamId = Effect.gen(function* () {
  const { teamId } = yield* VercelEnvironment.current;
  if (teamId !== undefined) return teamId;
  const { teams: list } = yield* teams.getTeams({ limit: 2 });
  const only = list[0];
  if (list.length === 1 && only !== undefined) return only.id;
  return yield* Effect.fail(
    new MicrofrontendsTeamRequiredError({
      message:
        "Managing a Vercel microfrontends group requires a team scope — set VERCEL_TEAM_ID or log in with a team-scoped token.",
    }),
  );
});

const requiredTeamScope = Effect.map(requiredTeamId, (teamId) => ({
  teamId,
}));

type GroupEntry = microfrontends.GetMicrofrontendsGroupsResponseGroupsItem;

/** Find a group by id (preferred) or name across the team's groups. */
const findGroup = (
  scope: { teamId?: string },
  groupId: string | undefined,
  name: string,
) =>
  Effect.gen(function* () {
    const { groups } = yield* microfrontends.getMicrofrontendsGroups(scope);
    return (
      (groupId !== undefined
        ? groups.find((g) => g.group.id === groupId)
        : undefined) ?? groups.find((g) => g.group.name === name)
    );
  });

/** The member projects of a group entry that are enabled in the group. */
const membersOf = (entry: GroupEntry) =>
  entry.projects.filter(
    (p) =>
      p.microfrontends?.enabled === true &&
      (p.microfrontends.groupIds ?? []).includes(entry.group.id),
  );

const toAttributes = (entry: GroupEntry): MicrofrontendsGroupAttributes => {
  const members = membersOf(entry);
  const defaultApp = members.find((p) => p.microfrontends?.isDefaultApp);
  return {
    groupId: entry.group.id,
    name: entry.group.name,
    slug: entry.group.slug,
    fallbackEnvironment: entry.group.fallbackEnvironment,
    defaultAppProjectId: defaultApp?.id ?? "",
    applicationProjectIds: members
      .filter((p) => !p.microfrontends?.isDefaultApp)
      .map((p) => p.id)
      .sort(),
    createdAt: entry.group.createdAt,
    updatedAt: entry.group.updatedAt,
  };
};

export const MicrofrontendsGroupProvider = () =>
  Provider.succeed(MicrofrontendsGroup, {
    stables: ["groupId", "createdAt"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      // The default app is the group's root; moving it to another project
      // is a structural change the API has no single-call path for.
      if (
        olds?.defaultApp !== undefined &&
        news.defaultApp.projectId !== olds.defaultApp.projectId
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const scope = yield* requiredTeamScope;
      const name = output?.name ?? olds?.name ?? (yield* createGroupName(id));
      const entry = yield* findGroup(scope, output?.groupId, name);
      return entry === undefined ? undefined : toAttributes(entry);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* requiredTeamScope;
      const name = news.name ?? output?.name ?? (yield* createGroupName(id));
      const desiredApps: MicrofrontendsApp[] = [
        news.defaultApp,
        ...(news.applications ?? []),
      ];

      // Observe — the group listing is the only endpoint exposing group
      // metadata; `output` only caches the stable id.
      let entry = yield* findGroup(scope, output?.groupId, name);

      // Ensure — missing → create with the full membership.
      if (entry === undefined) {
        const created =
          yield* microfrontends.createMicrofrontendsGroupWithApplications({
            groupName: name,
            defaultApp: {
              projectId: news.defaultApp.projectId,
              ...(news.defaultApp.defaultRoute !== undefined
                ? { defaultRoute: news.defaultApp.defaultRoute }
                : {}),
            },
            otherApplications: (news.applications ?? []).map((app) => ({
              projectId: app.projectId,
              ...(app.defaultRoute !== undefined
                ? { defaultRoute: app.defaultRoute }
                : {}),
            })),
            ...scope,
          });
        entry = yield* findGroup(
          scope,
          created.newMicrofrontendsGroup.id,
          name,
        );
        if (entry === undefined) {
          return yield* Effect.fail(
            new MicrofrontendsGroupNotVisibleError({
              groupId: created.newMicrofrontendsGroup.id,
            }),
          );
        }
      }
      const groupId = entry.group.id;

      // Sync group metadata — rename and fallback environment ride the same
      // team-scoped PATCH; apply only on drift.
      const rename = entry.group.name !== name;
      const refallback =
        news.fallbackEnvironment !== undefined &&
        entry.group.fallbackEnvironment !== news.fallbackEnvironment;
      if (rename || refallback) {
        const teamId = yield* requiredTeamId;
        yield* teams.updateMicrofrontendsGroup({
          teamId,
          groupId,
          ...(rename ? { name } : {}),
          ...(refallback
            ? { fallbackEnvironment: news.fallbackEnvironment }
            : {}),
        });
      }

      // Sync membership — diff OBSERVED members against the desired apps
      // and apply only the per-project deltas.
      const observedMembers = membersOf(entry);
      for (const app of desiredApps) {
        const observed = observedMembers.find((p) => p.id === app.projectId);
        const wantDefault = app.projectId === news.defaultApp.projectId;
        const isMissing = observed === undefined;
        const wrongDefault =
          !isMissing &&
          (observed.microfrontends?.isDefaultApp ?? false) !== wantDefault;
        const wrongRoute =
          !isMissing &&
          app.defaultRoute !== undefined &&
          observed.microfrontends?.defaultRoute !== app.defaultRoute;
        if (isMissing || wrongDefault || wrongRoute) {
          yield* projects.updateMicrofrontends({
            projectId: app.projectId,
            microfrontendsGroupId: groupId,
            enabled: true,
            ...(wantDefault ? { isDefaultApp: true } : {}),
            ...(app.defaultRoute !== undefined
              ? { defaultRoute: app.defaultRoute }
              : {}),
            ...scope,
          });
        }
      }
      for (const observed of observedMembers) {
        if (!desiredApps.some((app) => app.projectId === observed.id)) {
          yield* projects.updateMicrofrontends({
            projectId: observed.id,
            enabled: false,
            ...scope,
          });
        }
      }

      // Return — re-observe so the Attributes reflect the synced state.
      const final = yield* findGroup(scope, groupId, name);
      return toAttributes(final ?? entry);
    }),
    delete: Effect.fn(function* ({ output }) {
      const teamId = yield* requiredTeamId;
      // Already gone (out-of-band delete) is success, not an error. The
      // API detaches member projects itself (live-verified: deleting a
      // group with attached members succeeds).
      yield* teams
        .deleteMicrofrontendsGroup({ teamId, groupId: output.groupId })
        .pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        );
    }),
    list: Effect.fn(function* () {
      const scope = yield* requiredTeamScope;
      const { groups } = yield* microfrontends.getMicrofrontendsGroups(scope);
      return groups.map(toAttributes);
    }),
  });
