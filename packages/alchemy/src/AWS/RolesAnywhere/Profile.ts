import * as rolesanywhere from "@distilled.cloud/aws/rolesanywhere";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { durationToSeconds } from "../IAM/common.ts";
import type { Providers } from "../Providers.ts";
import {
  readRolesAnywhereTags,
  syncRolesAnywhereTags,
  toWireTags,
} from "./internal.ts";

/**
 * Raised when the RolesAnywhere API acknowledges a profile write but returns
 * no profile detail and the profile cannot be found by name afterwards.
 */
export class ProfileMissing extends Data.TaggedError("ProfileMissing")<{
  readonly name: string;
}> {}

export interface ProfileProps {
  /**
   * Name of the profile. If omitted, a unique name is generated from the app,
   * stage and logical ID. The name is updatable in place.
   */
  profileName?: string;
  /**
   * IAM role ARNs that IAM Roles Anywhere is trusted to assume on behalf of
   * authenticated workloads. Each role's trust policy must trust
   * `rolesanywhere.amazonaws.com`.
   */
  roleArns: string[];
  /**
   * An inline IAM session policy (JSON) applied to the vended session,
   * further restricting the assumed role's effective permissions.
   */
  sessionPolicy?: string;
  /**
   * Managed policy ARNs that apply to the vended session as a permissions
   * intersection.
   */
  managedPolicyArns?: string[];
  /**
   * How long vended session credentials are valid for, e.g. `"1 hour"` or
   * `Duration.minutes(15)` (a bare number is milliseconds). Rounded to whole
   * seconds on the wire (900-43200).
   * @default 3600 seconds
   */
  durationSeconds?: Duration.Input;
  /**
   * Whether temporary credential requests must include instance properties.
   * Immutable after creation — changing it replaces the profile.
   * @default false
   */
  requireInstanceProperties?: boolean;
  /**
   * Whether the vended session can carry a caller-specified role session
   * name.
   * @default false
   */
  acceptRoleSessionName?: boolean;
  /**
   * Whether the profile is enabled. When disabled, temporary credential
   * requests with this profile fail.
   * @default true
   */
  enabled?: boolean;
  /**
   * User-defined tags for the profile.
   */
  tags?: Record<string, string>;
}

export interface Profile extends Resource<
  "AWS.RolesAnywhere.Profile",
  ProfileProps,
  {
    /**
     * Unique ID of the profile.
     */
    profileId: string;
    /**
     * ARN of the profile.
     */
    profileArn: string;
    /**
     * Name of the profile.
     */
    profileName: string;
    /**
     * IAM role ARNs the profile can vend sessions for.
     */
    roleArns: string[];
    /**
     * Whether the profile is enabled.
     */
    enabled: boolean;
  },
  never,
  Providers
> {}

/**
 * An IAM Roles Anywhere profile — the list of IAM roles that the Roles
 * Anywhere service is trusted to assume for authenticated certificate
 * identities, optionally intersected with managed policies and an inline
 * session policy.
 * @resource
 * @section Creating a Profile
 * @example Basic Profile
 * ```typescript
 * const role = yield* IAM.Role("WorkloadRole", {
 *   assumeRolePolicyDocument: {
 *     Version: "2012-10-17",
 *     Statement: [
 *       {
 *         Effect: "Allow",
 *         Principal: { Service: "rolesanywhere.amazonaws.com" },
 *         Action: ["sts:AssumeRole", "sts:TagSession", "sts:SetSourceIdentity"],
 *       },
 *     ],
 *   },
 * });
 * const profile = yield* RolesAnywhere.Profile("Profile", {
 *   roleArns: [role.roleArn],
 * });
 * ```
 *
 * @section Restricting the Session
 * @example Session Policy and Duration
 * ```typescript
 * const profile = yield* RolesAnywhere.Profile("Profile", {
 *   roleArns: [role.roleArn],
 *   durationSeconds: "15 minutes",
 *   sessionPolicy: JSON.stringify({
 *     Version: "2012-10-17",
 *     Statement: [
 *       { Effect: "Allow", Action: "s3:GetObject", Resource: "*" },
 *     ],
 *   }),
 * });
 * ```
 */
export const Profile = Resource<Profile>("AWS.RolesAnywhere.Profile");

const toAttrs = (detail: rolesanywhere.ProfileDetail) => ({
  profileId: detail.profileId!,
  profileArn: detail.profileArn!,
  profileName: detail.name!,
  roleArns: [...(detail.roleArns ?? [])],
  enabled: detail.enabled ?? false,
});

const sameMembers = (
  left: ReadonlyArray<string> | undefined,
  right: ReadonlyArray<string> | undefined,
) => {
  const l = [...(left ?? [])].sort();
  const r = [...(right ?? [])].sort();
  return l.length === r.length && l.every((v, i) => v === r[i]);
};

export const ProfileProvider = () =>
  Provider.effect(
    Profile,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: Partial<ProfileProps>,
      ) {
        return (
          props.profileName ??
          (yield* createPhysicalName({ id, maxLength: 255 }))
        );
      });

      /** Find a profile by its user-facing name across all pages. */
      const findByName = (name: string) =>
        rolesanywhere.listProfiles.items({}).pipe(
          Stream.filter((detail) => detail.name === name),
          Stream.runHead,
          Effect.map((head) => (head._tag === "Some" ? head.value : undefined)),
        );

      const getById = (profileId: string) =>
        rolesanywhere.getProfile({ profileId }).pipe(
          Effect.map((r) => r.profile),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );

      return {
        stables: ["profileId", "profileArn"],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          // requireInstanceProperties has no member on updateProfile — it is
          // immutable after create, so a change forces a replacement.
          if (
            (olds?.requireInstanceProperties ?? false) !==
            (news.requireInstanceProperties ?? false)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const found = output?.profileId
            ? yield* getById(output.profileId)
            : yield* findByName(yield* createName(id, olds ?? {}));
          if (found === undefined) return undefined;
          const attrs = toAttrs(found);
          const tags = yield* readRolesAnywhereTags(attrs.profileArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.profileName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredEnabled = news.enabled ?? true;
          const desiredDurationSeconds = durationToSeconds(
            news.durationSeconds,
          );

          // 1. Observe — cloud state is authoritative; output caches the id.
          let live = output?.profileId
            ? yield* getById(output.profileId)
            : yield* findByName(name);

          // 2. Ensure — create if missing.
          if (live === undefined) {
            const created = yield* rolesanywhere.createProfile({
              name,
              roleArns: news.roleArns,
              sessionPolicy: news.sessionPolicy,
              managedPolicyArns: news.managedPolicyArns,
              durationSeconds: desiredDurationSeconds,
              requireInstanceProperties: news.requireInstanceProperties,
              acceptRoleSessionName: news.acceptRoleSessionName,
              enabled: desiredEnabled,
              tags: toWireTags(desiredTags),
            });
            live = created.profile ?? (yield* findByName(name));
            if (live === undefined) {
              return yield* new ProfileMissing({ name });
            }
          } else {
            // 3. Sync — converge the mutable aspects (name, roleArns,
            // sessionPolicy, managedPolicyArns, durationSeconds,
            // acceptRoleSessionName) by diffing observed against desired.
            const desiredName = news.profileName ?? live.name!;
            const drift =
              live.name !== desiredName ||
              !sameMembers(live.roleArns, news.roleArns) ||
              !sameMembers(live.managedPolicyArns, news.managedPolicyArns) ||
              (news.sessionPolicy !== undefined &&
                live.sessionPolicy !== news.sessionPolicy) ||
              (desiredDurationSeconds !== undefined &&
                live.durationSeconds !== desiredDurationSeconds) ||
              (news.acceptRoleSessionName !== undefined &&
                (live.acceptRoleSessionName ?? false) !==
                  news.acceptRoleSessionName);
            if (drift) {
              const updated = yield* rolesanywhere.updateProfile({
                profileId: live.profileId!,
                name: desiredName,
                roleArns: news.roleArns,
                sessionPolicy: news.sessionPolicy,
                managedPolicyArns: news.managedPolicyArns,
                durationSeconds: desiredDurationSeconds,
                acceptRoleSessionName: news.acceptRoleSessionName,
              });
              live = updated.profile ?? live;
            }
          }

          if ((live.enabled ?? false) !== desiredEnabled) {
            // The enable/disable response can echo the pre-toggle state — the
            // successful call itself is authoritative for the flag.
            yield* desiredEnabled
              ? rolesanywhere.enableProfile({ profileId: live.profileId! })
              : rolesanywhere.disableProfile({ profileId: live.profileId! });
            live = { ...live, enabled: desiredEnabled };
          }

          // 3b. Sync tags against observed cloud tags.
          yield* syncRolesAnywhereTags(live.profileArn!, desiredTags);

          yield* session.note(live.profileId!);
          return toAttrs(live);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* rolesanywhere
            .deleteProfile({ profileId: output.profileId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        list: () =>
          rolesanywhere.listProfiles.items({}).pipe(
            Stream.map(toAttrs),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          ),
      };
    }),
  );
