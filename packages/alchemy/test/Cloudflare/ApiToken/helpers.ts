import { apiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { ProfileStore, ProfileStoreLive } from "@/Auth/Profile.ts";
import { Credentials } from "@/Cloudflare/Credentials.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";

const cloudflareMethod = await Effect.gen(function* () {
  const profiles = yield* ProfileStore;
  const { name } = yield* profiles.current;
  return (yield* profiles.getProfile(name))?.providers.Cloudflare?.method;
}).pipe(
  Effect.provide(Layer.provide(ProfileStoreLive, PlatformServices)),
  Effect.orElseSucceed(() => undefined),
  Effect.runPromise,
);

// TODO: move every testing profile to Cloudflare OAuth so these always run.
export const cloudflareOAuthProfile =
  cloudflareMethod === "oauth" &&
  process.env.CLOUDFLARE_API_TOKEN === undefined &&
  process.env.CLOUDFLARE_API_KEY === undefined;

/** List the account's Workers scripts with `apiToken`, retrying while the new token propagates. */
export const listScriptsWithToken = (accountId: string, apiToken: Redacted.Redacted<string>) =>
  workers
    .listScripts({ accountId })
    .pipe(
      Effect.provideService(Credentials, Effect.succeed(apiTokenCredentials({ apiToken }))),
      Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 8 }),
    );
