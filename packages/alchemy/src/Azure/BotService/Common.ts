import * as botservice from "@distilled.cloud/azure/botservice";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** ARM names, IDs, and locations compare case-insensitively. */
export const sameArm = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/** Bot Service resources (bots, channels, connections) live in `global` by default. */
export const DEFAULT_BOT_LOCATION = "global";

/** Unwrap an optional secret. */
export const reveal = (
  value: Redacted.Redacted<string> | string | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

/**
 * Whether every field set in `desired` has the same value in `observed`.
 * Objects compare recursively, arrays element by element (same length),
 * so server-populated fields the user did not set are ignored.
 */
export const isSubset = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      observed.length === desired.length &&
      desired.every((item, i) => isSubset(item, observed[i]))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    return Object.entries(desired as Record<string, unknown>).every(
      ([key, value]) =>
        isSubset(value, (observed as Record<string, unknown>)[key]),
    );
  }
  return desired === observed;
};

/**
 * Channels and connections cannot carry their own tags (Azure ignores them
 * and reports the bot's), so a child is owned by whoever owns its bot: the
 * bot must carry this stack/stage's ownership tags.
 */
export const botOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
) {
  const bot = yield* orUndefinedIfNotFound(
    botservice.GetBot({ subscriptionId, resourceGroupName, resourceName }),
  );
  const { stack, stage } = yield* stackAndStage;
  return (
    bot?.tags?.["alchemy::stack"] === stack &&
    bot?.tags?.["alchemy::stage"] === stage
  );
});
