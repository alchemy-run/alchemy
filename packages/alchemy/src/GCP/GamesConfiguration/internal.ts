import * as gamesConfiguration from "@distilled.cloud/gcp/gamesConfiguration_v1configuration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const DEFAULT_LOCALE = "en-US";
export const DEFAULT_ACHIEVEMENT_TYPE = "STANDARD";
export const DEFAULT_INITIAL_STATE = "REVEALED";
export const DEFAULT_POINT_VALUE = 5;
export const DEFAULT_STEPS_TO_UNLOCK = 10;
export const DEFAULT_SCORE_ORDER = "LARGER_IS_BETTER";
export const MAX_ACHIEVEMENT_NAME_LENGTH = 100;
export const MAX_ACHIEVEMENT_DESCRIPTION_LENGTH = 500;
export const MAX_LEADERBOARD_NAME_LENGTH = 100;
export const PROBE_APPLICATION_ID = "1";

export const applicationIdsFromEnv = () => {
  const raw =
    process.env.GCP_GAMESCONFIGURATION_APPLICATION_ID?.trim() ||
    process.env.GCP_GAMES_APPLICATION_ID?.trim() ||
    process.env.GCP_PLAY_GAMES_APPLICATION_ID?.trim();
  if (!raw) return [] as string[];
  return raw.split(/[,\s]+/).filter((name) => name.length > 0);
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const sameNumber = (
  left: number | undefined,
  right: number | undefined,
) => (left ?? 0) === (right ?? 0);

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const emptyList = <A>() => Effect.succeed([] as A[]);

export const catchMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" | "Forbidden" } =>
        error._tag === "NotFound" || error._tag === "Forbidden",
      () => Effect.succeed(undefined),
    ),
  );

export const ignoreMissing = <E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<unknown, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" | "Forbidden" } =>
        error._tag === "NotFound" || error._tag === "Forbidden",
      () => Effect.void,
    ),
  );

const markerOf = (
  _labels: Record<string, string>,
  stack: string,
  stage: string,
  id: string,
) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(labels, stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (stack.length >= stage.length && stack.length >= id.length) {
      stack = stack.slice(0, -1);
    } else if (stage.length >= id.length) {
      stage = stage.slice(0, -1);
    } else {
      id = id.slice(0, -1);
    }
    marker = markerOf(labels, stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_ACHIEVEMENT_DESCRIPTION_LENGTH,
): string => {
  const marker = fitMarker(labels, Math.min(800, maxLength));
  const trimmed = text?.trim();
  const combined =
    trimmed && trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
  return combined.slice(0, maxLength);
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_ACHIEVEMENT_NAME_LENGTH,
): string => {
  const trimmed = text?.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return fitMarker(labels, maxLength);
  const minMarker = 24;
  const reserved = Math.min(
    trimmed.length + 1,
    Math.max(0, maxLength - minMarker),
  );
  const marker = fitMarker(labels, maxLength - reserved);
  return `${marker} ${trimmed}`.slice(0, maxLength);
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!text?.startsWith("[alchemy ")) {
    return { labels: {}, text };
  }
  const end = text.indexOf("]");
  if (end < 0) return { labels: {}, text };
  const labels: Record<string, string> = {};
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseOwnership(text);
    if (!hasOwnershipMarker(text)) return false;
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
    return (
      prefixMatch(
        expected[alchemyLabelKeys.stack] ?? "",
        labels[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.stage] ?? "",
        labels[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.id] ?? "",
        labels[alchemyLabelKeys.id] ?? "",
      )
    );
  });

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const toDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = MAX_ACHIEVEMENT_NAME_LENGTH,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested.slice(0, maxLength);
    }
    if (existing !== undefined && existing.length > 0) {
      return existing.slice(0, maxLength);
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength: Math.min(40, maxLength),
      lowercase: true,
    });
    return generated.slice(0, maxLength);
  });

export const translationsOf = (
  bundle: gamesConfiguration.LocalizedStringBundle | undefined,
): gamesConfiguration.LocalizedString[] =>
  (bundle?.translations ?? []).map((entry) => ({
    locale: entry.locale,
    value: entry.value,
  }));

export const translationValue = (
  bundle: gamesConfiguration.LocalizedStringBundle | undefined,
  locale = DEFAULT_LOCALE,
): string | undefined => {
  const translations = translationsOf(bundle);
  const match =
    translations.find((entry) => (entry.locale ?? locale) === locale) ??
    translations[0];
  return match?.value;
};

export const ownershipTextFromBundle = (
  bundle: gamesConfiguration.LocalizedStringBundle | undefined,
  locale = DEFAULT_LOCALE,
) => {
  for (const entry of translationsOf(bundle)) {
    if (hasOwnershipMarker(entry.value)) return entry.value;
  }
  return translationValue(bundle, locale);
};

export const publicBundle = (
  bundle: gamesConfiguration.LocalizedStringBundle | undefined,
): gamesConfiguration.LocalizedStringBundle | undefined => {
  if (bundle === undefined) return undefined;
  return {
    translations: translationsOf(bundle).map((entry) => ({
      locale: entry.locale,
      value: parseOwnership(entry.value).text,
    })),
  };
};

export const publicText = (
  bundle: gamesConfiguration.LocalizedStringBundle | undefined,
  locale = DEFAULT_LOCALE,
) => parseOwnership(translationValue(bundle, locale)).text;

export const withTranslation = (
  bundle: gamesConfiguration.LocalizedStringBundle | undefined,
  locale: string,
  value: string,
): gamesConfiguration.LocalizedStringBundle => {
  const translations = translationsOf(bundle);
  const idx = translations.findIndex(
    (entry) => (entry.locale ?? locale) === locale,
  );
  const next = { locale, value };
  if (idx >= 0) {
    translations[idx] = { ...translations[idx], ...next };
  } else {
    translations.unshift(next);
  }
  return { translations };
};

export const stampBundle = (
  labels: Record<string, string>,
  bundle: gamesConfiguration.LocalizedStringBundle | undefined,
  fallback: string | undefined,
  locale: string,
  maxLength: number,
  line: boolean,
): gamesConfiguration.LocalizedStringBundle => {
  const current =
    parseOwnership(translationValue(bundle, locale)).text ?? fallback;
  const stamped = line
    ? encodeOwnershipLine(labels, current, maxLength)
    : encodeOwnership(labels, current, maxLength);
  return withTranslation(bundle, locale, stamped);
};

export const sameBundle = (
  left: gamesConfiguration.LocalizedStringBundle | undefined,
  right: gamesConfiguration.LocalizedStringBundle | undefined,
) =>
  jsonEqual(
    translationsOf(left)
      .map((entry) => ({
        locale: entry.locale ?? DEFAULT_LOCALE,
        value: entry.value ?? "",
      }))
      .sort((a, b) => a.locale.localeCompare(b.locale)),
    translationsOf(right)
      .map((entry) => ({
        locale: entry.locale ?? DEFAULT_LOCALE,
        value: entry.value ?? "",
      }))
      .sort((a, b) => a.locale.localeCompare(b.locale)),
  );

export const defaultScoreFormat =
  (): gamesConfiguration.GamesNumberFormatConfiguration => ({
    numberFormatType: "NUMERIC",
    numDecimalPlaces: 0,
  });

export const achievementOwnershipText = (
  achievement: gamesConfiguration.AchievementConfiguration,
) =>
  ownershipTextFromBundle(achievement.draft?.description) ??
  ownershipTextFromBundle(achievement.draft?.name) ??
  ownershipTextFromBundle(achievement.published?.description) ??
  ownershipTextFromBundle(achievement.published?.name);

export const leaderboardOwnershipText = (
  leaderboard: gamesConfiguration.LeaderboardConfiguration,
) =>
  ownershipTextFromBundle(leaderboard.draft?.name) ??
  ownershipTextFromBundle(leaderboard.published?.name);

export const achievementOwnedByAlchemy = (
  id: string,
  achievement: gamesConfiguration.AchievementConfiguration,
) => ownedByAlchemy(id, achievementOwnershipText(achievement));

export const leaderboardOwnedByAlchemy = (
  id: string,
  leaderboard: gamesConfiguration.LeaderboardConfiguration,
) => ownedByAlchemy(id, leaderboardOwnershipText(leaderboard));

export type AchievementWithApp = gamesConfiguration.AchievementConfiguration & {
  applicationId: string;
};

export type LeaderboardWithApp = gamesConfiguration.LeaderboardConfiguration & {
  applicationId: string;
};

export const getAchievement = (achievementId: string) =>
  achievementId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        gamesConfiguration.getAchievementConfigurations({ achievementId }),
      );

export const getLeaderboard = (leaderboardId: string) =>
  leaderboardId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        gamesConfiguration.getLeaderboardConfigurations({ leaderboardId }),
      );

export const listAchievements = (applicationId: string) =>
  applicationId.length === 0
    ? emptyList<gamesConfiguration.AchievementConfiguration>()
    : gamesConfiguration.listAchievementConfigurations
        .pages({ applicationId, maxResults: 200 })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.items ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () =>
            emptyList<gamesConfiguration.AchievementConfiguration>(),
          ),
          Effect.catchTag("Forbidden", () =>
            emptyList<gamesConfiguration.AchievementConfiguration>(),
          ),
        );

export const listLeaderboards = (applicationId: string) =>
  applicationId.length === 0
    ? emptyList<gamesConfiguration.LeaderboardConfiguration>()
    : gamesConfiguration.listLeaderboardConfigurations
        .pages({ applicationId, maxResults: 200 })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.items ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () =>
            emptyList<gamesConfiguration.LeaderboardConfiguration>(),
          ),
          Effect.catchTag("Forbidden", () =>
            emptyList<gamesConfiguration.LeaderboardConfiguration>(),
          ),
        );

export const findOwnedAchievement = (id: string, applicationId: string) =>
  Effect.gen(function* () {
    const achievements = yield* listAchievements(applicationId);
    for (const achievement of achievements) {
      if (yield* achievementOwnedByAlchemy(id, achievement)) {
        return achievement;
      }
    }
    return undefined;
  });

export const findOwnedLeaderboard = (id: string, applicationId: string) =>
  Effect.gen(function* () {
    const leaderboards = yield* listLeaderboards(applicationId);
    for (const leaderboard of leaderboards) {
      if (yield* leaderboardOwnedByAlchemy(id, leaderboard)) {
        return leaderboard;
      }
    }
    return undefined;
  });

export const listOwnedAchievements = () =>
  Effect.gen(function* () {
    const applicationIds = applicationIdsFromEnv();
    const pages = yield* Effect.forEach(
      applicationIds,
      (applicationId) =>
        listAchievements(applicationId).pipe(
          Effect.map((achievements) =>
            achievements
              .filter((achievement) =>
                hasOwnershipMarker(achievementOwnershipText(achievement)),
              )
              .map((achievement): AchievementWithApp => ({
                ...achievement,
                applicationId,
              })),
          ),
        ),
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const listOwnedLeaderboards = () =>
  Effect.gen(function* () {
    const applicationIds = applicationIdsFromEnv();
    const pages = yield* Effect.forEach(
      applicationIds,
      (applicationId) =>
        listLeaderboards(applicationId).pipe(
          Effect.map((leaderboards) =>
            leaderboards
              .filter((leaderboard) =>
                hasOwnershipMarker(leaderboardOwnershipText(leaderboard)),
              )
              .map((leaderboard): LeaderboardWithApp => ({
                ...leaderboard,
                applicationId,
              })),
          ),
        ),
      { concurrency: 4 },
    );
    return pages.flat();
  });
