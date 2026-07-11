import * as lexm from "@distilled.cloud/aws/lex-models-v2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  readLexTags,
  toLexName,
  retryWhileConflict,
  syncLexTags,
  waitForAliasSettled,
} from "./internal.ts";

export interface BotAliasProps {
  /**
   * ID of the bot the alias belongs to. Changing it replaces the alias.
   */
  botId: string;
  /**
   * Name of the alias. Mutable — renames update the alias in place (identity
   * is the generated alias ID).
   * @default ${app}-${id}-${stage}-${suffix}
   */
  botAliasName?: string;
  /**
   * The numbered bot version the alias points at. Leave undefined to create
   * the alias unassociated and point it at a version later. Pass the
   * `botVersion` attribute of a `BotVersion` so the alias depends on it.
   */
  botVersion?: string;
  /**
   * Description of the alias.
   */
  description?: string;
  /**
   * Tags to associate with the alias.
   */
  tags?: Record<string, string>;
}

export interface BotAlias extends Resource<
  "AWS.LexV2.BotAlias",
  BotAliasProps,
  {
    /** Unique identifier assigned to the alias. */
    botAliasId: string;
    /** Name of the alias. */
    botAliasName: string;
    /** ARN of the alias (`arn:aws:lex:...:bot-alias/{botId}/{botAliasId}`). */
    botAliasArn: string;
    /** ID of the bot the alias belongs to. */
    botId: string;
    /** The bot version the alias points at, if associated. */
    botVersion: string | undefined;
    /** Current status of the alias (e.g. `Available`). */
    botAliasStatus: string;
    /** Tags currently associated with the alias. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An alias of an Amazon Lex V2 bot — a stable pointer to a numbered bot
 * version that runtime conversations (e.g. `RecognizeText`) target.
 *
 * @resource
 * @section Creating an Alias
 * @example Alias on a Version
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const alias = yield* AWS.LexV2.BotAlias("Live", {
 *   botId: version.botId,
 *   botVersion: version.botVersion,
 * });
 * ```
 *
 * @example Unassociated Alias
 * ```typescript
 * // point it at a version later without changing consumers
 * const alias = yield* AWS.LexV2.BotAlias("Staging", {
 *   botId: bot.botId,
 * });
 * ```
 *
 * @section Conversing at Runtime
 * @example RecognizeText from a Lambda
 * ```typescript
 * const recognizeText = yield* AWS.LexV2.RecognizeText(alias);
 * const reply = yield* recognizeText({
 *   localeId: "en_US",
 *   sessionId: "user-123",
 *   text: "hello",
 * });
 * ```
 */
export const BotAlias = Resource<BotAlias>("AWS.LexV2.BotAlias");

const createAliasName = (
  id: string,
  props: { botAliasName?: string | undefined },
) =>
  Effect.gen(function* () {
    if (props.botAliasName) return props.botAliasName;
    return toLexName(yield* createPhysicalName({ id, maxLength: 100 }));
  });

const describeAlias = Effect.fn(function* (botId: string, botAliasId: string) {
  return yield* lexm
    .describeBotAlias({ botId, botAliasId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
});

/** Find an alias of the bot by exact name (used when state was lost). */
const findAliasByName = Effect.fn(function* (
  botId: string,
  botAliasName: string,
) {
  const pages = yield* lexm.listBotAliases.pages({ botId }).pipe(
    Stream.runCollect,
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed([] as lexm.ListBotAliasesResponse[]),
    ),
  );
  const summary = Array.from(pages)
    .flatMap((page) => page.botAliasSummaries ?? [])
    .find((alias) => alias.botAliasName === botAliasName);
  if (summary?.botAliasId === undefined) return undefined;
  return yield* describeAlias(botId, summary.botAliasId);
});

const aliasArnOf = Effect.fn(function* (botId: string, botAliasId: string) {
  const { accountId, region } = yield* AWSEnvironment.current;
  return `arn:aws:lex:${region}:${accountId}:bot-alias/${botId}/${botAliasId}`;
});

const attributesOf = Effect.fn(function* (
  alias: lexm.DescribeBotAliasResponse,
) {
  const botAliasArn = yield* aliasArnOf(alias.botId!, alias.botAliasId!);
  return {
    botAliasId: alias.botAliasId!,
    botAliasName: alias.botAliasName!,
    botAliasArn,
    botId: alias.botId!,
    botVersion: alias.botVersion,
    botAliasStatus: alias.botAliasStatus!,
    tags: yield* readLexTags(botAliasArn),
  } satisfies BotAlias["Attributes"];
});

export const BotAliasProvider = () =>
  Provider.effect(
    BotAlias,
    Effect.gen(function* () {
      return {
        stables: ["botAliasId", "botAliasArn", "botId"],

        // Sub-resource keyed entirely by its bot — nuke reaches it through
        // the parent bot's deletion.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ id, olds, output }) {
          const botId = output?.botId ?? olds?.botId;
          if (botId === undefined) return undefined;
          const observed =
            output?.botAliasId !== undefined
              ? yield* describeAlias(botId, output.botAliasId)
              : yield* findAliasByName(
                  botId,
                  yield* createAliasName(id, olds ?? {}),
                );
          if (observed === undefined) return undefined;
          const attrs = yield* attributesOf(observed);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (olds?.botId !== news.botId) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const botAliasName = yield* createAliasName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. OBSERVE — output.botAliasId is only a cache; fall back to name.
          let observed =
            output?.botAliasId !== undefined
              ? yield* describeAlias(news.botId, output.botAliasId)
              : undefined;
          if (observed === undefined) {
            observed = yield* findAliasByName(news.botId, botAliasName);
          }

          // 2. ENSURE — create when missing.
          if (observed === undefined) {
            const created = yield* retryWhileConflict(
              lexm.createBotAlias({
                botId: news.botId,
                botAliasName,
                botVersion: news.botVersion,
                description: news.description,
                tags: desiredTags,
              }),
            );
            observed = yield* waitForAliasSettled(
              news.botId,
              created.botAliasId!,
            );
          } else if (
            // 3. SYNC — apply the delta when a declared prop drifted.
            observed.botAliasName !== botAliasName ||
            (observed.botVersion ?? undefined) !==
              (news.botVersion ?? undefined) ||
            (observed.description ?? undefined) !==
              (news.description ?? undefined)
          ) {
            yield* retryWhileConflict(
              lexm.updateBotAlias({
                botId: news.botId,
                botAliasId: observed.botAliasId!,
                botAliasName,
                botVersion: news.botVersion,
                description: news.description,
              }),
            );
            observed = yield* waitForAliasSettled(
              news.botId,
              observed.botAliasId!,
            );
          }

          // 3b. SYNC TAGS — diff against observed cloud tags.
          const botAliasArn = yield* aliasArnOf(
            news.botId,
            observed.botAliasId!,
          );
          const observedTags = yield* readLexTags(botAliasArn);
          yield* syncLexTags(botAliasArn, observedTags, desiredTags);

          yield* session.note(observed.botAliasId!);
          return yield* attributesOf(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          // Lex reports a missing alias (or already-deleted parent bot) as
          // PreconditionFailed.
          yield* retryWhileConflict(
            lexm.deleteBotAlias({
              botId: output.botId,
              botAliasId: output.botAliasId,
              skipResourceInUseCheck: true,
            }),
          ).pipe(
            Effect.catchTag("PreconditionFailedException", () => Effect.void),
          );
        }),
      };
    }),
  );
