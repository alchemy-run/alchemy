import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Lexicon } from "./Lexicon.ts";

/**
 * Dashboard UI providers for AWS Polly resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const LexiconUI = UIProvider.succeed<Lexicon>("AWS.Polly.Lexicon", {
  displayName: "Polly Lexicon",
  icon: "languages",
  color: "#01A88D",
  category: "ai",
  summary: (ctx) => ctx.attrs?.lexiconName,
  facts: (ctx) => [
    { label: "name", value: ctx.attrs?.lexiconName, copy: true },
    { label: "arn", value: ctx.attrs?.lexiconArn, mono: true, copy: true },
    { label: "alphabet", value: ctx.attrs?.alphabet },
    { label: "language", value: ctx.attrs?.languageCode },
    { label: "lexemes", value: ctx.attrs?.lexemesCount },
  ],
});

export const ui = () => Layer.mergeAll(LexiconUI);
