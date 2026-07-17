import * as polly from "@distilled.cloud/aws/polly";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface LexiconProps {
  /**
   * Name of the lexicon — an alphanumeric string up to 20 characters
   * (`[0-9A-Za-z]{1,20}`). If omitted, a unique name is generated. Changing
   * this replaces the lexicon.
   */
  lexiconName?: string;
  /**
   * The lexicon content, a W3C Pronunciation Lexicon Specification (PLS)
   * XML document. Updatable in place — `PutLexicon` is a true upsert.
   */
  content: string;
}

export interface Lexicon extends Resource<
  "AWS.Polly.Lexicon",
  LexiconProps,
  {
    /**
     * Name of the lexicon (its identity within the region). Pass it as
     * `LexiconNames` to `SynthesizeSpeech` / `StartSpeechSynthesisTask`.
     */
    lexiconName: string;
    /**
     * ARN of the lexicon, e.g. `arn:aws:polly:us-east-1:123456789012:lexicon/casing`.
     */
    lexiconArn: string;
    /**
     * Phonetic alphabet declared by the PLS document (`ipa` or `x-sampa`).
     */
    alphabet: string | undefined;
    /**
     * Language code declared by the PLS document, e.g. `en-US`.
     */
    languageCode: string | undefined;
    /**
     * Number of lexemes in the lexicon.
     */
    lexemesCount: number | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon Polly pronunciation lexicon — a W3C PLS document stored in a
 * region that customizes how `SynthesizeSpeech` pronounces specific words.
 * Identity is the region-scoped `lexiconName`; the PLS `content` is
 * updatable in place.
 *
 * @resource
 * @section Managing Lexicons
 * @example Store a pronunciation lexicon
 * ```typescript
 * const lexicon = yield* AWS.Polly.Lexicon("Acronyms", {
 *   lexiconName: "acronyms",
 *   content: `<?xml version="1.0" encoding="UTF-8"?>
 * <lexicon version="1.0" xmlns="http://www.w3.org/2005/01/pronunciation-lexicon"
 *          alphabet="ipa" xml:lang="en-US">
 *   <lexeme><grapheme>W3C</grapheme><alias>World Wide Web Consortium</alias></lexeme>
 * </lexicon>`,
 * });
 * ```
 *
 * @example Synthesize speech with the lexicon applied
 * ```typescript
 * const synthesizeSpeech = yield* AWS.Polly.SynthesizeSpeech();
 * const result = yield* synthesizeSpeech({
 *   OutputFormat: "mp3",
 *   VoiceId: "Joanna",
 *   Text: "The W3C maintains the PLS standard.",
 *   LexiconNames: [lexicon.lexiconName],
 * });
 * ```
 */
export const Lexicon = Resource<Lexicon>("AWS.Polly.Lexicon");

/**
 * Unwrap the lexicon `Content` (distilled types it as a `SensitiveString`,
 * which decodes to `Redacted`) to its plain PLS XML string.
 */
const contentOf = (lexicon: polly.Lexicon | undefined): string | undefined => {
  const content = lexicon?.Content;
  return content === undefined
    ? undefined
    : Redacted.isRedacted(content)
      ? Redacted.value(content)
      : content;
};

const toAttributes = (
  name: string,
  arn: string,
  attributes: polly.LexiconAttributes | undefined,
) => ({
  lexiconName: name,
  lexiconArn: arn,
  alphabet: attributes?.Alphabet,
  languageCode: attributes?.LanguageCode,
  lexemesCount: attributes?.LexemesCount,
});

export const LexiconProvider = () =>
  Provider.effect(
    Lexicon,
    Effect.gen(function* () {
      // Lexicon names must match [0-9A-Za-z]{1,20} — generate the engine
      // name, drop every non-alphanumeric character, and keep the trailing
      // 20 characters so the unique suffix survives truncation.
      const toName = (id: string, props: LexiconProps) =>
        props.lexiconName
          ? Effect.succeed(props.lexiconName)
          : createPhysicalName({ id, maxLength: 26, suffixLength: 10 }).pipe(
              Effect.map((n) => n.replace(/[^0-9A-Za-z]/g, "").slice(-20)),
            );

      const lexiconArn = (name: string) =>
        Effect.gen(function* () {
          const { accountId, region } = yield* AWSEnvironment.current;
          return `arn:aws:polly:${region}:${accountId}:lexicon/${name}`;
        });

      const getOne = (name: string) =>
        polly
          .getLexicon({ Name: name })
          .pipe(
            Effect.catchTag("LexiconNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const waitForContent = (name: string, desired: string) =>
        Effect.gen(function* () {
          let found: polly.GetLexiconOutput | undefined;
          let consecutiveMatches = 0;
          for (let attempt = 0; attempt < 20; attempt++) {
            found = yield* getOne(name);
            if (contentOf(found?.Lexicon) === desired) {
              // Polly can transiently return a response whose Lexicon payload
              // is absent immediately after PutLexicon. Require two stable
              // reads before exposing the updated resource to dependants.
              consecutiveMatches++;
              if (consecutiveMatches === 2) return found;
            } else {
              consecutiveMatches = 0;
            }
            yield* Effect.sleep("500 millis");
          }
          return yield* Effect.fail(
            new Error(
              `Polly lexicon '${name}' did not converge to the desired content`,
            ),
          );
        });

      const waitUntilGone = (name: string) =>
        Effect.gen(function* () {
          let consecutiveMisses = 0;
          for (let attempt = 0; attempt < 20; attempt++) {
            const found = yield* getOne(name);
            if (found === undefined) {
              consecutiveMisses++;
              if (consecutiveMisses === 2) return;
            } else {
              consecutiveMisses = 0;
            }
            yield* Effect.sleep("500 millis");
          }
          return yield* Effect.fail(
            new Error(
              `Polly lexicon '${name}' is still observable after deletion`,
            ),
          );
        });

      return {
        stables: ["lexiconName", "lexiconArn"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toName(id, olds ?? { content: "" })) !==
            (yield* toName(id, news))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.lexiconName ?? (yield* toName(id, olds ?? { content: "" }));
          const found = yield* getOne(name);
          if (!found) return undefined;
          return toAttributes(
            name,
            found.LexiconAttributes?.LexiconArn ?? (yield* lexiconArn(name)),
            found.LexiconAttributes,
          );
        }),
        list: () =>
          Effect.gen(function* () {
            const attrs: {
              lexiconName: string;
              lexiconArn: string;
              alphabet: string | undefined;
              languageCode: string | undefined;
              lexemesCount: number | undefined;
            }[] = [];
            let nextToken: string | undefined;
            // ListLexicons is not modeled as paginated by distilled; walk
            // NextToken manually with a hard page bound.
            for (let page = 0; page < 25; page++) {
              const res = yield* polly.listLexicons({
                NextToken: nextToken,
              });
              for (const lexicon of res.Lexicons ?? []) {
                if (lexicon.Name) {
                  attrs.push(
                    toAttributes(
                      lexicon.Name,
                      lexicon.Attributes?.LexiconArn ??
                        (yield* lexiconArn(lexicon.Name)),
                      lexicon.Attributes,
                    ),
                  );
                }
              }
              nextToken = res.NextToken;
              if (!nextToken) break;
            }
            return attrs;
          }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.lexiconName ?? (yield* toName(id, news));

          // Observe — cloud state is authoritative.
          const observed = yield* getOne(name);

          // Ensure + sync in one step: PutLexicon is a true upsert, so a
          // single call converges both the missing and the content-drift
          // cases. Skip the API entirely when the observed content matches.
          if (contentOf(observed?.Lexicon) !== news.content) {
            yield* polly.putLexicon({ Name: name, Content: news.content });
          }

          yield* session.note(name);
          // PutLexicon can return before GetLexicon exposes the new document.
          // Wait briefly for the exact desired content so callers never observe
          // stale state immediately after a successful deploy.
          const final = yield* waitForContent(name, news.content);
          return toAttributes(
            name,
            final?.LexiconAttributes?.LexiconArn ?? (yield* lexiconArn(name)),
            final?.LexiconAttributes,
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          // Idempotent — the lexicon may already be gone.
          yield* polly
            .deleteLexicon({ Name: output.lexiconName })
            .pipe(
              Effect.catchTag("LexiconNotFoundException", () => Effect.void),
            );
          // DeleteLexicon may return before the control plane consistently
          // reports absence. Confirm deletion so nuke cannot leave a lexicon
          // behind and lose the only state that identifies it.
          yield* waitUntilGone(output.lexiconName);
        }),
      };
    }),
  );
