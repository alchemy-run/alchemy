import * as b2bi from "@distilled.cloud/aws/b2bi";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readB2biTags, syncB2biTags, toWireTags } from "./internal.ts";

export interface ProfileProps {
  /**
   * The name of the profile.
   */
  name: string;
  /**
   * Name for the business associated with this profile.
   */
  businessName: string;
  /**
   * The phone number associated with the business, in E.164 format
   * (e.g. `+1234567890`).
   */
  phone: string;
  /**
   * The email address associated with this customer profile.
   */
  email?: string;
  /**
   * Whether Amazon Web Services logs each event in an Amazon CloudWatch log
   * group for the profile.
   * @default "ENABLED"
   */
  logging?: "ENABLED" | "DISABLED";
  /**
   * User-defined tags for the profile.
   */
  tags?: Record<string, string>;
}

export interface Profile extends Resource<
  "AWS.B2BI.Profile",
  ProfileProps,
  {
    profileId: string;
    profileArn: string;
    name: string;
    businessName: string;
    logGroupName: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An AWS B2B Data Interchange (B2BI) customer profile. A profile is the
 * mechanism used to model a distinct private network; you can have up to
 * five profiles per account. Profiles are credential-free and fully
 * self-service, so their lifecycle is directly testable.
 * @resource
 * @section Creating a Profile
 * @example Basic Profile
 * ```typescript
 * const profile = yield* B2BI.Profile("Acme", {
 *   name: "Acme Trading",
 *   businessName: "Acme Corp",
 *   phone: "+15555550100",
 *   email: "edi@acme.example",
 * });
 * ```
 *
 * @section Disabling CloudWatch Logging
 * @example Logging Disabled
 * ```typescript
 * const profile = yield* B2BI.Profile("Acme", {
 *   name: "Acme Trading",
 *   businessName: "Acme Corp",
 *   phone: "+15555550100",
 *   logging: "DISABLED",
 * });
 * ```
 */
export const Profile = Resource<Profile>("AWS.B2BI.Profile");

const toAttrs = (r: b2bi.GetProfileResponse | b2bi.CreateProfileResponse) => ({
  profileId: r.profileId,
  profileArn: r.profileArn,
  name: r.name,
  businessName: r.businessName,
  logGroupName: r.logGroupName,
});

export const ProfileProvider = () =>
  Provider.effect(
    Profile,
    Effect.gen(function* () {
      /** Find a profile by its user-facing name across all pages. */
      const findByName = (name: string) =>
        b2bi.listProfiles.items({}).pipe(
          Stream.filter((s) => s.name === name),
          Stream.runHead,
          Effect.flatMap((head) =>
            head._tag === "Some"
              ? b2bi
                  .getProfile({ profileId: head.value.profileId })
                  .pipe(
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed(undefined),
                    ),
                  )
              : Effect.succeed(undefined),
          ),
        );

      return {
        stables: ["profileId", "profileArn"],

        read: Effect.fn(function* ({ id, olds, output }) {
          const found = output?.profileId
            ? yield* b2bi
                .getProfile({ profileId: output.profileId })
                .pipe(
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                )
            : yield* findByName(olds?.name ?? "");
          if (found === undefined) return undefined;
          const attrs = toAttrs(found);
          const tags = yield* readB2biTags(attrs.profileArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative; output caches the id.
          let live = output?.profileId
            ? yield* b2bi
                .getProfile({ profileId: output.profileId })
                .pipe(
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                )
            : yield* findByName(news.name);

          // 2. Ensure — create if missing.
          if (live === undefined) {
            const created = yield* b2bi.createProfile({
              name: news.name,
              businessName: news.businessName,
              phone: news.phone,
              email: news.email,
              logging: news.logging ?? "ENABLED",
              tags: toWireTags(desiredTags),
            });
            live = yield* b2bi.getProfile({ profileId: created.profileId });
          } else {
            // 3. Sync — converge mutable settings (name/businessName/phone/
            // email). logging is immutable after create.
            const nameDrift = live.name !== news.name;
            const bizDrift = live.businessName !== news.businessName;
            if (nameDrift || bizDrift) {
              yield* b2bi.updateProfile({
                profileId: live.profileId,
                name: news.name,
                businessName: news.businessName,
                phone: news.phone,
                email: news.email,
              });
              live = yield* b2bi.getProfile({ profileId: live.profileId });
            }
          }

          // 3b. Sync tags against observed cloud tags.
          yield* syncB2biTags(live.profileArn, desiredTags);

          yield* session.note(live.profileId);
          return toAttrs(live);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* b2bi
            .deleteProfile({ profileId: output.profileId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        list: () =>
          b2bi.listProfiles.items({}).pipe(
            Stream.mapEffect((s) =>
              b2bi.getProfile({ profileId: s.profileId }).pipe(
                Effect.map(toAttrs),
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(undefined),
                ),
              ),
            ),
            Stream.filter((item) => item !== undefined),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          ),
      };
    }),
  );
