import * as modelServing from "@distilled.cloud/stackit/model_serving";
import { Unowned } from "alchemy/AdoptPolicy";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { recordsEqual } from "alchemy/Util/equal";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { type ProjectScope, readGeneration, resolveProjectScope } from "../IaaS/internal.ts";
import {
  findOwnedAiItem,
  isPastValidUntil,
  labelPatch,
  redactedValue,
  userAiLabels,
} from "../internal/aiTokens.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { ensureServiceEnabled } from "../internal/enable.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import { desiredGenerationLabels, hasInstanceLabel, isAlchemyOwned } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  getTokenOrUndefined,
  listScopeTokens,
  MODEL_SERVING_SERVICE_ID,
  scopeRequest,
  TOKEN_NAME_MAX_LENGTH,
  TOKEN_TIMEOUT,
} from "./internal.ts";

export interface TokenProps {
  /**
   * Name of the token: 1 to 200 letters, digits, spaces, `_` and `-`. Updates in place.
   *
   * @default a name generated from the stack, stage and logical ID
   */
  name?: string;
  /**
   * Description: letters, digits, spaces and `.`, `:`, `/`, `-`. Updates in place; omit to leave
   * the live value alone.
   */
  description?: string;
  /**
   * How long the token lives, as a duration such as `5h30m40s`. The API can't change it, so
   * changing it replaces the token. A deploy after the token expired replaces it too.
   *
   * @default the token never expires
   */
  ttlDuration?: string;
  /**
   * Any values. Changing them replaces the token, which is how to rotate it: the new token has a
   * new value and the old one is deleted.
   */
  rotateWhenChanged?: Record<string, string>;
  /** User labels. Alchemy's ownership labels are always merged in. Updates in place. */
  labels?: Record<string, string>;
  /** Project that owns the token. Changing it replaces the token. @default the profile's project */
  projectId?: string;
  /** Region of the token. Changing it replaces the token. @default the profile's region */
  region?: string;
}

export interface TokenAttributes {
  /** STACKIT token id (UUID). */
  tokenId: string;
  /** Project that owns the token. */
  projectId: string;
  /** Region of the token. */
  region: string;
  /**
   * The token, `Redacted`. The API returns it only when it is created, so it is `undefined` on a
   * token taken over with `--adopt`.
   */
  token: Redacted.Redacted<string> | undefined;
  /** Whether the token was taken over with `--adopt`, so Alchemy never had its value. */
  adopted: boolean;
  /** Name of the token. */
  name: string;
  /** Description, if any. */
  description: string | undefined;
  /** `creating`, `active`, `deleting`, or `inactive` once it expired. */
  state: string;
  /** Last moment the token is valid. */
  validUntil: string;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
}

export type Token = Resource<
  "Stackit.ModelServing.Token",
  TokenProps,
  TokenAttributes,
  never,
  Providers
>;

/**
 * An auth token of STACKIT AI Model Serving: one token reaches every shared chat and embedding
 * model in its region. Bind it with `Stackit.ModelServing.LanguageModel`, `ChatCompletion` or
 * `CreateEmbeddings`, or hand it to any OpenAI client. The value stays `Redacted`.
 *
 * STACKIT returns the value only when the token is created. A deploy that crashes before saving
 * it finds the token by its labels on the next run, deletes it and creates a new one. A token
 * with the same `name` that lacks those labels is reported as unowned; taking it over with
 * `--adopt` leaves `token` `undefined`, because no API can return its value.
 *
 * Changing `ttlDuration`, `rotateWhenChanged`, `projectId` or `region` replaces the token, and so
 * does a deploy after it expired. A host holding the old value only sees the new one when it
 * redeploys. With an explicit `name` the old token is deleted first.
 *
 * The token itself costs nothing: inference is billed per million tokens of text. The first deploy
 * enables the service (`cloud.stackit.model-serving`) for the project.
 *
 * See [STACKIT's AI Model Serving docs](https://docs.stackit.cloud/products/data-and-ai/ai-model-serving/).
 *
 * :::caution[Changing `ttlDuration`, `rotateWhenChanged`, `projectId` or `region` replaces the Token]
 * So does a deploy after it expired. A host holding the old value only sees the new
 * one when it redeploys. With an explicit `name` the old token is deleted first.
 * :::
 *
 * ### Creating a Token
 * **Example:** A token that never expires
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const token = yield* Stackit.ModelServing.Token("Ai", {});
 * ```
 *
 * **Example:** A named token that expires
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const token = yield* Stackit.ModelServing.Token("Ai", {
 *   name: "my-app",
 *   description: "Inference from the app",
 *   ttlDuration: "720h",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Rotating a Token
 * **Example:** Replace the token by changing `rotateWhenChanged`
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // Change the value to rotate. A host bound to the token gets the new value on the same deploy.
 * const token = yield* Stackit.ModelServing.Token("Ai", {
 *   rotateWhenChanged: { rotation: "2026-11" },
 * });
 * ```
 *
 * ### Using the Token in a Runtime
 * **Example:** Generate text from a Cloudflare Worker with Effect AI
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import { LanguageModel } from "effect/ai";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Ai = Stackit.ModelServing.Token("Ai", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const model = yield* Stackit.ModelServing.LanguageModel(yield* Ai, {
 *       model: "openai/gpt-oss-20b",
 *     });
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const reply = yield* LanguageModel.generateText({ prompt: "Say hello." }).pipe(
 *           Effect.provide(model),
 *         );
 *         return yield* HttpServerResponse.json({ text: reply.text });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ModelServing.LanguageModelHttp)),
 * ) {}
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Changing `ttlDuration` makes a new token
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // The API can't change a lifetime. A host bound to the token gets the new value on the same
 * // deploy; anything else holding the old value stops working.
 * const token = yield* Stackit.ModelServing.Token("Ai", { ttlDuration: "24h" });
 * ```
 *
 * @resource
 * @product STACKIT AI Model Serving
 * @category ModelServing
 */
export const Token = Resource<Token>("Stackit.ModelServing.Token");

/** What a token carries over from before this observation. */
interface KnownToken {
  readonly token: Redacted.Redacted<string> | undefined;
  readonly adopted: boolean;
}

const toAttrs = (
  scope: ProjectScope,
  token: modelServing.Token | modelServing.TokenCreated,
  known: KnownToken,
): TokenAttributes => ({
  tokenId: token.id,
  projectId: scope.projectId,
  region: scope.region,
  token: known.token,
  adopted: known.adopted,
  name: token.name,
  description: token.description === "" ? undefined : token.description,
  state: token.state,
  validUntil: token.validUntil,
  labels: userAiLabels(token.labels),
});

const generatedName = (id: string) => createPhysicalName({ id, maxLength: TOKEN_NAME_MAX_LENGTH });

/** Wait until the token is `active`, and `applied` holds. */
const waitForActive = (
  scope: ProjectScope,
  tId: string,
  applied: (token: modelServing.Token) => boolean = () => true,
) =>
  waitFor({
    resource: `STACKIT model serving token ${tId}`,
    // A 404 this soon after a create isn't taken as gone: the budget bounds the wait.
    read: getTokenOrUndefined(scope, tId),
    ready: (token) => token?.state === "active" && applied(token),
    failed: (token) =>
      token?.state === "inactive" || token?.state === "deleting" ? token.state : undefined,
    state: (token) => token?.state,
    timeout: TOKEN_TIMEOUT,
  });

const waitForGone = (scope: ProjectScope, tId: string) =>
  waitUntilGone({
    resource: `STACKIT model serving token ${tId}`,
    read: getTokenOrUndefined(scope, tId),
    state: (token) => token.state,
    timeout: TOKEN_TIMEOUT,
  });

/** Delete a token and wait until it is gone. Idempotent. */
const deleteToken = (scope: ProjectScope, tId: string) =>
  Effect.gen(function* () {
    const current = yield* getTokenOrUndefined(scope, tId);
    if (current === undefined) return;
    if (current.state !== "deleting") {
      yield* modelServing
        .deleteToken({ ...scopeRequest(scope), tId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }
    yield* waitForGone(scope, tId);
  });

/** Create a token and wait for it. A token lost to a failed wait is deleted: no state holds it. */
const createToken = (
  scope: ProjectScope,
  id: string,
  generationId: string,
  input: {
    readonly name: string;
    readonly news: TokenProps;
    readonly labels: Record<string, string>;
  },
) =>
  Effect.gen(function* () {
    const create = modelServing.createToken({
      ...scopeRequest(scope),
      name: input.name,
      labels: input.labels,
      ...(input.news.description !== undefined ? { description: input.news.description } : {}),
      ...(input.news.ttlDuration !== undefined ? { ttlDuration: input.news.ttlDuration } : {}),
    });
    const { token: created } = yield* create.pipe(
      // A token of this generation has a value nobody saved: replace it. Anything else, like a
      // foreign token holding an explicit name, stays the caller's Conflict.
      Effect.catchTag("Conflict", (conflict) =>
        Effect.gen(function* () {
          const tokens = yield* listScopeTokens(scope);
          const owned = yield* findOwnedAiItem(id, tokens, generationId);
          if (owned === undefined) return yield* conflict;
          yield* deleteToken(scope, owned.id);
          return yield* create;
        }),
      ),
    );
    const live = yield* waitForActive(scope, created.id).pipe(
      Effect.onError(() => deleteToken(scope, created.id).pipe(Effect.ignore)),
    );
    return toAttrs(scope, live ?? created, {
      token: redactedValue(created.content),
      adopted: false,
    });
  });

export const TokenProvider = () =>
  Provider.succeed(Token, {
    stables: ["tokenId", "projectId", "region"],

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const tokens = yield* listScopeTokens(scope);
      return tokens
        .filter((token) => isAlchemyOwned(token.labels))
        .map((token) => toAttrs(scope, token, { token: undefined, adopted: false }));
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // A generated name carries the generation; an explicit one may not exist twice.
      const deleteFirst = rawProp<TokenProps>(news, "name") !== undefined;
      if (
        hasUnresolvedTrigger<TokenProps>(news, [
          "ttlDuration",
          "rotateWhenChanged",
          "projectId",
          "region",
        ])
      ) {
        return { action: "replace", deleteFirst } as const;
      }
      const resolved = triggerProps<TokenProps>(news);
      const env = yield* StackitEnvironment.current;
      if (
        (resolved.projectId ?? env.projectId) !== output.projectId ||
        (resolved.region ?? env.region) !== output.region
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // The API doesn't report a lifetime, so `olds` is all there is. On an adopted row there is
      // none, and the live token stands.
      if (
        olds !== undefined &&
        (resolved.ttlDuration !== olds.ttlDuration ||
          !recordsEqual(olds.rotateWhenChanged ?? {}, resolved.rotateWhenChanged ?? {}))
      ) {
        return { action: "replace", deleteFirst } as const;
      }
      if (output.adopted) return undefined;
      // `read` doesn't run at plan for a created row: expiry is noticed here. What `validUntil`
      // holds on a token with no lifetime is undocumented, so only a lifetime makes it count.
      const now = yield* Clock.currentTimeMillis;
      if (
        output.state === "inactive" ||
        (resolved.ttlDuration !== undefined && isPastValidUntil(output.validUntil, now))
      ) {
        return { action: "replace", deleteFirst } as const;
      }
      // A value a crash lost: reconcile deletes the token and makes a new one.
      if (output.token === undefined) return { action: "update" } as const;
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const known: KnownToken = {
        token: output?.token,
        adopted: output?.adopted ?? false,
      };
      if (output !== undefined) {
        const byId = yield* getTokenOrUndefined(scope, output.tokenId);
        if (byId !== undefined && byId.state !== "deleting") return toAttrs(scope, byId, known);
      }
      const tokens = yield* listScopeTokens(scope);
      // A crashed create has neither state nor a previous generation, and any generation of this
      // logical id is ours. A replacement only owns its own.
      const generation = readGeneration({ instanceId, output, previous });
      const owned = yield* findOwnedAiItem(id, tokens, generation);
      if (owned !== undefined) return toAttrs(scope, owned, known);
      const name = output?.name ?? olds?.name;
      const named = tokens.find((token) => token.name === name);
      if (named === undefined) return undefined;
      const attrs = toAttrs(scope, named, known);
      // A name says nothing beyond its project and region, so the generation being replaced has
      // to match on all three.
      const isPrevious =
        previous?.tokenId === named.id &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region;
      return isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const name = news.name ?? (yield* generatedName(id));
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);
      // `output` only speaks for this token while it sits in the same project and region.
      const cached =
        output?.projectId === scope.projectId && output.region === scope.region
          ? output
          : undefined;

      yield* ensureServiceEnabled({ ...scope, serviceId: MODEL_SERVING_SERVICE_ID });

      // 1. Observe — by cached id, then by this generation's labels (a crashed create).
      let current: modelServing.Token | undefined;
      if (cached !== undefined) current = yield* getTokenOrUndefined(scope, cached.tokenId);
      if (current === undefined) {
        const tokens = yield* listScopeTokens(scope);
        current = yield* findOwnedAiItem(id, tokens, instanceId);
      }
      // A delete in flight (an interrupted destroy): let it finish.
      if (current?.state === "deleting") {
        yield* waitForGone(scope, current.id);
        current = undefined;
      }

      let value = current === undefined ? undefined : cached?.token;
      // No value and labels of this generation: Alchemy created it and a crash lost the value.
      // No value and no such labels: it was taken over with `--adopt`, nobody here can tell who
      // holds its value, and it is never recreated.
      const adopted =
        current !== undefined &&
        (cached?.adopted === true ||
          (value === undefined && !hasInstanceLabel(instanceId, current.labels)));

      // A token with no known value, or an expired one, is useless to what it is bound to, and
      // can't be repaired.
      if (
        current !== undefined &&
        !adopted &&
        (value === undefined || current.state === "inactive")
      ) {
        yield* deleteToken(scope, current.id);
        current = undefined;
        value = undefined;
      }

      // 2. Ensure — the response holds the only copy of the value.
      if (current === undefined) {
        return yield* createToken(scope, id, instanceId, { name, news, labels });
      }
      const known: KnownToken = { token: value, adopted };

      // An adopted token past its life has nothing to sync, and PATCH would refuse it.
      if (current.state === "inactive") return toAttrs(scope, current, known);
      if (current.state !== "active") {
        current = (yield* waitForActive(scope, current.id)) ?? current;
      }

      // 3. Sync — observed name, description and labels against the desired ones.
      const descriptionDrifted =
        news.description !== undefined && (current.description ?? "") !== news.description;
      const labelsDelta = labelPatch(current.labels, labels);
      if (current.name !== name || descriptionDrifted || labelsDelta !== undefined) {
        yield* modelServing.partialUpdateToken({
          ...scopeRequest(scope),
          tId: current.id,
          ...(current.name !== name ? { name } : {}),
          ...(descriptionDrifted ? { description: news.description } : {}),
          ...(labelsDelta !== undefined ? { labels: labelsDelta } : {}),
        });
        // Waiting for the new values means a read from before the PATCH can't pass.
        current =
          (yield* waitForActive(
            scope,
            current.id,
            (token) =>
              token.name === name &&
              (news.description === undefined || (token.description ?? "") === news.description),
          )) ?? current;
      }

      // 4. Return
      return toAttrs(scope, current, known);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteToken({ projectId: output.projectId, region: output.region }, output.tokenId);
    }),
  });
