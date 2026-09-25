import * as adsense from "@distilled.cloud/gcp/adsense_v2";
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

export const runLifecycle =
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_ADSENSE;

export const probeParent =
  "accounts/pub-0000000000000000/adclients/ca-pub-0000000000000000";
export const probeName = `${probeParent}/customchannels/alchemy-missing`;

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const toAdClientName = (account: string, adClient: string) => {
  const trimmed = adClient.replace(/\/+$/, "").trim();
  if (trimmed.includes("/adclients/")) return trimmed;
  const accountName = account.startsWith("accounts/")
    ? account
    : `accounts/${account}`;
  const id = trimmed.startsWith("adclients/") ? lastSegment(trimmed) : trimmed;
  return `${accountName}/adclients/${id}`;
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
    const explicit = process.env.GCP_ADSENSE_PARENT?.trim();
    if (explicit) return explicit.replace(/\/+$/, "");
    const account = process.env.GCP_ADSENSE_ACCOUNT?.trim();
    const adClient = process.env.GCP_ADSENSE_ADCLIENT?.trim();
    if (account && adClient) return toAdClientName(account, adClient);
    const accounts = yield* collect(
      adsense.listAccounts.pages({ pageSize: 200 }),
      (page) => page.accounts,
    ).pipe(
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as adsense.Account[]),
      ),
      Effect.catchTag("Forbidden", () =>
        Effect.succeed([] as adsense.Account[]),
      ),
    );
    for (const row of accounts) {
      if (!row.name) continue;
      const clients = yield* collect(
        adsense.listAccountsAdclients.pages({
          parent: row.name,
          pageSize: 200,
        }),
        (page) => page.adClients,
      ).pipe(
        Effect.catchTag("NotFound", () =>
          Effect.succeed([] as adsense.AdClient[]),
        ),
        Effect.catchTag("Forbidden", () =>
          Effect.succeed([] as adsense.AdClient[]),
        ),
      );
      const ready = clients.find((client) => client.name);
      if (ready?.name) return ready.name;
    }
    return undefined;
  });

export const waitUntilGone = (name: string) =>
  adsense.getAccountsAdclientsCustomchannels({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );
