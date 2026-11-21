import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Discord from "@alchemy.run/discord";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import { cases, ctx } from "./bindings-cases.ts";
import { MP3_BEEP, mp3DataUri } from "./fixtures.ts";
import DiscordBindingsWorker, { Channel, Guild, Hook } from "./fixtures/bindings-worker.ts";
import { dc } from "./helpers.ts";

const providers = Layer.mergeAll(Cloudflare.providers(), Discord.providers());
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers });

const tags = [
  "provider:cloudflare",
  "provider:cloudflare:worker",
  "provider:discord",
  "provider:discord:bindings",
  "live",
];

// Every binding runs inside a deployed Worker, with the bot token the
// binding bound into it (webhook bindings: only the webhook token).
const Stack = Alchemy.Stack(
  "DiscordBindingsStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    const guild = yield* Guild;
    const channel = yield* Channel;
    const hook = yield* Hook;
    const worker = yield* DiscordBindingsWorker;
    return {
      url: worker.url.as<string>(),
      guildId: guild.guildId,
      channelId: channel.channelId,
      webhookId: hook.webhookId,
    };
  }),
);

const stack = beforeAll(deploy(Stack), { timeout: 300_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 300_000 });

export type Answer = { data?: any; error?: { _tag: string; message: string } };

const call = (binding: string, request: unknown) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const response = yield* Test.executeWhenReady(
      HttpClientRequest.post(`${url.replace(/\/+$/, "")}/${binding}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(request ?? {}),
      ),
    );
    expect(response.status).toBe(200);
    return (yield* response.json) as Answer;
  });

// Out-of-band setup the scenario needs: a poll and a soundboard sound.
const setup = Effect.gen(function* () {
  const out = yield* stack;
  ctx.guildId = out.guildId;
  ctx.channelId = out.channelId;
  ctx.webhookId = out.webhookId;
  const poll = yield* dc(
    discord.createMessage({
      channel_id: out.channelId,
      poll: {
        question: { text: "alchemy bindings poll" },
        answers: [{ poll_media: { text: "yes" } }, { poll_media: { text: "no" } }],
        duration: 1,
      },
    } as discord.CreateMessageRequest),
  );
  ctx.pollMessageId = poll.id;
  const sounds = yield* dc(discord.listGuildSoundboardSounds({ guild_id: out.guildId }));
  const existing = sounds.items.find((s) => s.name === "alchemy-bindings");
  ctx.soundId =
    existing?.sound_id ??
    (yield* dc(
      discord.createGuildSoundboardSound({
        guild_id: out.guildId,
        name: "alchemy-bindings",
        sound: mp3DataUri(MP3_BEEP),
      }),
    )).sound_id;
});

afterAll(
  Effect.gen(function* () {
    if (ctx.soundId && ctx.guildId) {
      yield* dc(
        discord.deleteGuildSoundboardSound({ guild_id: ctx.guildId, sound_id: ctx.soundId }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }
  }),
);

describe.sequential("Discord bindings", () => {
  test("setup", setup, { tags, timeout: 120_000 });

  for (const [name, c] of Object.entries(cases)) {
    describe(name, () => {
      test(
        c.expect === "ok" ? "succeeds from a deployed Worker" : `fails with ${c.expect}: ${c.why}`,
        Effect.gen(function* () {
          // LeaveGuild is called on a guild the bot isn't in, through a
          // separate stack, so the bindings Worker keeps its guild.
          const answer =
            name === "LeaveGuild" ? yield* leaveForeignGuild : yield* call(name, c.request(ctx));
          if (c.expect === "ok") {
            expect(answer.error).toBeUndefined();
            c.check?.(answer.data, ctx);
          } else {
            expect(answer.error?._tag).toBe(c.expect);
          }
        }),
        { tags, timeout: 60_000 },
      );
    });
  }
});

/**
 * LeaveGuild can't run from the Worker: its bound guild is the one the
 * Worker's bindings live in, and leaving it would end the suite. The same
 * distilled call runs here against a guild id the bot isn't in, and fails
 * with NotFound (10004 Unknown Guild). Index status: blocked (destructive).
 */
const NONE = "1";
const leaveForeignGuild = Effect.gen(function* () {
  const answer = yield* dc(discord.leaveGuild({ guild_id: NONE })).pipe(
    Effect.map((data) => ({ data }) as Answer),
    Effect.catch((error) => Effect.succeed({ error: { _tag: error._tag, message: "" } } as Answer)),
  );
  return answer;
});
