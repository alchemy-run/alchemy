import * as polly from "@distilled.cloud/aws/polly";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import type { Lexicon } from "./Lexicon.ts";

/**
 * Runtime binding for `polly:GetLexicon` — read the PLS content and
 * attributes of a pronunciation lexicon at runtime.
 *
 * Bind it to a `Lexicon` resource; the deploy-time half grants
 * `polly:GetLexicon` scoped to that lexicon's ARN and the runtime callable
 * injects the lexicon name. The returned `Lexicon.Content` is `Redacted`
 * (distilled models it as sensitive) — unwrap with `Redacted.value(...)` at
 * the point of use. Provide the implementation with
 * `Effect.provide(AWS.Polly.GetLexiconHttp)`.
 *
 * ### Managing Lexicons
 * **Example:** Read a lexicon's content at runtime
 * ```typescript
 * // init
 * const getLexicon = yield* AWS.Polly.GetLexicon(lexicon);
 *
 * // runtime
 * const result = yield* getLexicon();
 * const content = result.Lexicon?.Content;
 * const xml =
 *   content === undefined
 *     ? undefined
 *     : Redacted.isRedacted(content)
 *       ? Redacted.value(content)
 *       : content;
 * ```
 *
 * @binding
 */
export interface GetLexicon extends Binding.Service<
  GetLexicon,
  "AWS.Polly.GetLexicon",
  <L extends Lexicon>(
    lexicon: L,
  ) => Effect.Effect<() => Effect.Effect<polly.GetLexiconOutput, polly.GetLexiconError>>
> {}
export const GetLexicon = Binding.Service<GetLexicon>("AWS.Polly.GetLexicon");

// GetLexicon is one of the few Polly actions with resource-level IAM (the
// `lexicon` resource type), so the grant is scoped to the lexicon's ARN
// rather than `*` — that's why this binding is bespoke instead of a
// makePollyHttpBinding thin call.
export const GetLexiconHttp = Layer.effect(
  GetLexicon,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const getLexicon = yield* AWSBindings.withCredentials(polly.getLexicon);

    return Effect.fn(function* <L extends Lexicon>(lexicon: L) {
      const Name = yield* lexicon.lexiconName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Polly.GetLexicon(${lexicon})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["polly:GetLexicon"],
              Resource: [lexicon.lexiconArn],
            },
          ],
        });
      }
      return Effect.fn(`AWS.Polly.GetLexicon(${lexicon.LogicalId})`)(function* () {
        return yield* getLexicon({ Name: yield* Name });
      });
    });
  }),
);
