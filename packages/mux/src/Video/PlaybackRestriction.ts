import * as MuxRetry from "@distilled.cloud/mux/Retry";
import * as Video from "@distilled.cloud/mux/video";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { Providers } from "../Providers.ts";

export interface ReferrerRestriction {
  /**
   * Domains allowed to play. `[]` denies every domain, `["*"]` allows any,
   * otherwise up to 10 domains or DNS-style wildcards such as `*.example.com`.
   */
  allowed_domains: string[];
  /**
   * Allow requests with no `Referer` header. Native apps (iOS, Android,
   * smart TVs) send none.
   * @default false
   */
  allow_no_referrer?: boolean;
}

export interface UserAgentRestriction {
  /**
   * Allow requests with no `User-Agent` header.
   * @default true
   */
  allow_no_user_agent?: boolean;
  /**
   * Allow user agents Mux classifies as high risk.
   * @default true
   */
  allow_high_risk_user_agent?: boolean;
}

export interface PlaybackRestrictionProps {
  /** Which sites may play `signed` content, by `Referer` header. */
  referrer: ReferrerRestriction;
  /**
   * Which user agents may play. Settings left out return to Mux's defaults.
   * @default { allow_no_user_agent: true, allow_high_risk_user_agent: true }
   */
  user_agent?: UserAgentRestriction;
}

export interface PlaybackRestrictionAttributes {
  /** Mux playback restriction ID. Put it in a playback token's `playback_restriction_id` claim. */
  id: string;
  /** Unix timestamp (seconds, as a string) of creation. */
  created_at: string;
  /** Referrer rules as Mux applies them. */
  referrer: Required<ReferrerRestriction>;
  /** User agent rules as Mux applies them. */
  user_agent: Required<UserAgentRestriction>;
}

export type PlaybackRestriction = Resource<
  "Mux.Video.PlaybackRestriction",
  PlaybackRestrictionProps,
  PlaybackRestrictionAttributes,
  never,
  Providers
>;

/**
 * A Mux Playback Restriction: limits which sites and user agents may play
 * `signed` content. A restriction applies to a playback token whose
 * `playback_restriction_id` claim names it, so mint tokens with
 * `Mux.Video.PlaybackSigner` and pass `playbackRestrictionId`.
 *
 * Every prop updates the restriction in place, so its `id` never changes.
 * @see https://www.mux.com/docs/guides/secure-video-playback#using-referer-http-header-for-validation
 *
 * ### Creating a Playback Restriction
 * **Example:** Only allow playback on your own domains
 * ```typescript
 * const restriction = yield* Mux.Video.PlaybackRestriction("SiteOnly", {
 *   referrer: { allowed_domains: ["example.com", "*.example.com"] },
 * });
 * ```
 *
 * **Example:** Also allow native apps, but block high-risk user agents
 * ```typescript
 * const restriction = yield* Mux.Video.PlaybackRestriction("AppsAndSite", {
 *   referrer: { allowed_domains: ["example.com"], allow_no_referrer: true },
 *   user_agent: { allow_no_user_agent: false, allow_high_risk_user_agent: false },
 * });
 * ```
 *
 * ### Enforcing it on playback
 * **Example:** Sign tokens that carry the restriction
 * ```typescript
 * const key = yield* Mux.System.SigningKey("Playback");
 * const restriction = yield* Mux.Video.PlaybackRestriction("SiteOnly", {
 *   referrer: { allowed_domains: ["example.com"] },
 * });
 * const signer = yield* Mux.Video.PlaybackSigner(key);
 * // in a request handler, for a signed playback ID and the restriction's id:
 * const token = yield* signer.sign("PLAYBACK_ID", {
 *   playbackRestrictionId: "RESTRICTION_ID",
 * });
 * ```
 *
 * @resource
 */
export const PlaybackRestriction = Resource<PlaybackRestriction>("Mux.Video.PlaybackRestriction");

const USER_AGENT_DEFAULTS: Required<UserAgentRestriction> = {
  allow_no_user_agent: true,
  allow_high_risk_user_agent: true,
};

// Mux omits `allow_no_referrer` from responses when it is false.
const toAttrs = (rule: Video.PlaybackRestriction): PlaybackRestrictionAttributes => ({
  id: rule.id,
  created_at: rule.created_at,
  referrer: {
    allowed_domains: rule.referrer.allowed_domains ?? [],
    allow_no_referrer: rule.referrer.allow_no_referrer ?? false,
  },
  user_agent: {
    allow_no_user_agent:
      rule.user_agent.allow_no_user_agent ?? USER_AGENT_DEFAULTS.allow_no_user_agent,
    allow_high_risk_user_agent:
      rule.user_agent.allow_high_risk_user_agent ?? USER_AGENT_DEFAULTS.allow_high_risk_user_agent,
  },
});

const desired = (news: PlaybackRestrictionProps) => ({
  referrer: {
    allowed_domains: news.referrer.allowed_domains,
    allow_no_referrer: news.referrer.allow_no_referrer ?? false,
  },
  user_agent: { ...USER_AGENT_DEFAULTS, ...news.user_agent },
});

const sameReferrer = (a: Required<ReferrerRestriction>, b: Required<ReferrerRestriction>) =>
  a.allow_no_referrer === b.allow_no_referrer &&
  a.allowed_domains.length === b.allowed_domains.length &&
  a.allowed_domains.every((domain, i) => domain === b.allowed_domains[i]);

const sameUserAgent = (a: Required<UserAgentRestriction>, b: Required<UserAgentRestriction>) =>
  a.allow_no_user_agent === b.allow_no_user_agent &&
  a.allow_high_risk_user_agent === b.allow_high_risk_user_agent;

export const PlaybackRestrictionProvider = () =>
  Provider.effect(
    PlaybackRestriction,
    Effect.gen(function* () {
      const create = yield* Video.createPlaybackRestriction;
      const get = yield* Video.getPlaybackRestriction;
      const del = yield* Video.deletePlaybackRestriction;
      const list = yield* Video.listPlaybackRestrictions;
      const putReferrer = yield* Video.updateReferrerDomainRestriction;
      const putUserAgent = yield* Video.updateUserAgentRestriction;

      const observe = (id: string) =>
        get({ PLAYBACK_RESTRICTION_ID: id }).pipe(
          Effect.map((res) => toAttrs(res.data)),
          Effect.catchTag("NotFound", () => Effect.undefined),
        );

      return {
        stables: ["id", "created_at"],
        list: () =>
          list.items({ limit: 100 }).pipe(
            Stream.runCollect,
            Effect.map((rules) => rules.map(toAttrs)),
          ),
        reconcile: Effect.fn(function* ({ news, output }) {
          const want = desired(news);
          let current = output?.id ? yield* observe(output.id) : undefined;

          if (current === undefined) {
            // A create that failed with a 5xx may still have happened, so it
            // is retried only on throttling.
            const { data } = yield* create(want).pipe(MuxRetry.throttling);
            current = toAttrs(data);
          }

          if (!sameReferrer(current.referrer, want.referrer)) {
            const { data } = yield* putReferrer({
              PLAYBACK_RESTRICTION_ID: current.id,
              ...want.referrer,
            });
            current = toAttrs(data);
          }
          if (!sameUserAgent(current.user_agent, want.user_agent)) {
            const { data } = yield* putUserAgent({
              PLAYBACK_RESTRICTION_ID: current.id,
              ...want.user_agent,
            });
            current = toAttrs(data);
          }
          return current;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* del({ PLAYBACK_RESTRICTION_ID: output.id }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          return yield* observe(output.id);
        }),
      };
    }),
  );
