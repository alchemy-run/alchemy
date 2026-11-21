import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as discord from "@distilled.cloud/discord/discord";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";

/**
 * Run distilled Discord calls with the testing profile's bot token, outside a
 * provider (out-of-band setup and verification).
 */
const credentials = Layer.mergeAll(Discord.fromAuthProvider(), FetchHttpClient.layer).pipe(
  Layer.provideMerge(Discord.DiscordAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
);

export const dc = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(credentials));

export class TestGuildMissing extends Data.TaggedError("TestGuildMissing")<{
  readonly message: string;
}> {}

/**
 * The guild the Discord suites deploy into: the bot's guild named
 * `DISCORD_TEST_GUILD` (default `alchemy-test`), or the bot's only guild.
 * Create a server, invite the testing bot with Administrator
 * (`https://discord.com/oauth2/authorize?client_id=<app id>&scope=bot+applications.commands&permissions=8`),
 * and name it `alchemy-test`.
 */
export const testGuildId = Effect.gen(function* () {
  const name = yield* Config.String("DISCORD_TEST_GUILD").pipe(Config.withDefault("alchemy-test"));
  const guilds = (yield* dc(discord.listMyGuilds({ limit: 200 }))) ?? [];
  const guild =
    guilds.find((g) => g.name === name) ?? (guilds.length === 1 ? guilds[0] : undefined);
  if (guild === undefined) {
    return yield* new TestGuildMissing({
      message: `The Discord testing bot is in ${guilds.length} guild(s) and none is named '${name}'. Invite it to a test server named '${name}' (Administrator).`,
    });
  }
  return guild.id;
});

/** The testing bot's application id. */
export const testApplicationId = Effect.gen(function* () {
  return (yield* dc(discord.getMyApplication({}))).id;
});

/** The testing bot's user id. */
export const testBotUserId = Effect.gen(function* () {
  return (yield* dc(discord.getMyUser({}))).id;
});

class StillThere extends Data.TaggedError("StillThere")<{}> {}

/**
 * Poll `exists` (a distilled get mapped to `true`, with its typed `NotFound`
 * caught as `false`) until it reports `false`, bounded. Discord deletes
 * synchronously; the retry only covers edge caching.
 */
export const expectGone = <E, R>(exists: Effect.Effect<boolean, E, R>) =>
  exists.pipe(
    Effect.flatMap((there) => (there ? Effect.fail(new StillThere()) : Effect.void)),
    Effect.retry({
      while: (e) => Predicate.isTagged(e, "StillThere"),
      schedule: Schedule.spaced("1 second"),
      times: 10,
    }),
  );

/** Tags every Discord live test carries. */
export const tags = (resource: string) => [
  "provider:discord",
  `provider:discord:${resource}`,
  "live",
];
