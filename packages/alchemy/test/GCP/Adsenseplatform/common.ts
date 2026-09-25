import * as adsenseplatform from "@distilled.cloud/gcp/adsenseplatform_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

export const probeParent =
  "platforms/pub-0000000000000000/accounts/pub-0000000000000000";
export const probeName = `${probeParent}/sites/alchemy-missing`;
export const probeDomain = "alchemy-adsenseplatform-probe.example.com";

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const toPlatformName = (value: string) => {
  const trimmed = value.replace(/\/+$/, "").trim();
  if (trimmed.length === 0) return trimmed;
  return trimmed.startsWith("platforms/") ? trimmed : `platforms/${trimmed}`;
};

export const toParent = (value: string) => {
  const trimmed = value.replace(/\/+$/, "").trim();
  if (trimmed.includes("/accounts/")) {
    return trimmed.startsWith("platforms/") ? trimmed : `platforms/${trimmed}`;
  }
  return trimmed;
};

export const toAccountParent = (platform: string, account: string) => {
  const trimmed = account.replace(/\/+$/, "").trim();
  if (trimmed.includes("/accounts/")) return toParent(trimmed);
  const platformName = toPlatformName(platform);
  const id = trimmed.startsWith("accounts/") ? lastSegment(trimmed) : trimmed;
  return `${platformName}/accounts/${id}`;
};

const collect = <A, Page, E, R>(
  pages: Stream.Stream<Page, E, R>,
  pick: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(pick(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const resolveParent = () =>
  Effect.gen(function* () {
    const explicit = process.env.GCP_ADSENSEPLATFORM_PARENT?.trim();
    if (explicit) return toParent(explicit);
    const platform = process.env.GCP_ADSENSEPLATFORM_PLATFORM?.trim();
    const account = process.env.GCP_ADSENSEPLATFORM_ACCOUNT?.trim();
    if (platform && account) return toAccountParent(platform, account);
    if (!platform) return undefined;
    const platformName = toPlatformName(platform);
    const accounts = yield* collect(
      adsenseplatform.listPlatformsAccounts.pages({
        parent: platformName,
        pageSize: 200,
      }),
      (page) => page.accounts,
    ).pipe(
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as adsenseplatform.Account[]),
      ),
      Effect.catchTag("Forbidden", () =>
        Effect.succeed([] as adsenseplatform.Account[]),
      ),
    );
    const ready = accounts.find((row) => row.name);
    return ready?.name ? toParent(ready.name) : undefined;
  });

export const waitUntilGone = (name: string) =>
  adsenseplatform.getPlatformsAccountsSites({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );
