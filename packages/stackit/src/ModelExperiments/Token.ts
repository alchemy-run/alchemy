import * as modelExperiments from "@distilled.cloud/stackit/model_experiments";
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
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import { desiredGenerationLabels, hasInstanceLabel, isAlchemyOwned } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  conflictRetry,
  getInstanceOrUndefined,
  LIFECYCLE_TIMEOUT,
  listScopeInstances,
  NAME_MAX_LENGTH,
  scopeRequest,
} from "./internal.ts";

export interface TokenProps {
  /** Instance the token belongs to. Changing it replaces the token. */
  instanceId: string;
  /**
   * Name of the token: 1 to 64 letters, digits, spaces, `_` and `-`. Updates in place.
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
   * How long the token lives, as a duration such as `5h30m40s`, at most 6 months. The API can't
   * change it, so changing it replaces the token. A deploy after the token expired replaces it too.
   *
   * @default 6 months
   */
  ttlDuration?: string;
  /**
   * Any values. Changing them replaces the token, which is how to rotate it: the new token has a
   * new value and the old one is deleted.
   */
  rotateWhenChanged?: Record<string, string>;
  /** User labels. Alchemy's ownership labels are always merged in. Updates in place. */
  labels?: Record<string, string>;
  /** Project that owns the instance. Changing it replaces the token. @default the profile's project */
  projectId?: string;
  /** Region of the instance. Changing it replaces the token. @default the profile's region */
  region?: string;
}

export interface TokenAttributes {
  /** STACKIT token id (UUID). */
  tokenId: string;
  /** Instance the token belongs to. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Region of the instance. */
  region: string;
  /** MLflow's tracking URL of the instance, which the data bindings call. */
  instanceUrl: string;
  /**
   * The tracking token, `Redacted`. The API returns it only when it is created, so it is
   * `undefined` on a token taken over with `--adopt`.
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
  "Stackit.ModelExperiments.Token",
  TokenProps,
  TokenAttributes,
  never,
  Providers
>;

/**
 * A tracking token of a `Stackit.ModelExperiments.Instance`, scoped to that one instance: what the
 * MLflow SDK reads as `MLFLOW_TRACKING_TOKEN`, and what the tracking bindings (`LogMetric`,
 * `CreateRun`, ...) take. The value stays `Redacted`.
 *
 * STACKIT returns the value only when the token is created. A deploy that crashes before saving it
 * finds the token by its labels on the next run, deletes it and creates a new one. A token with
 * the same `name` that lacks those labels is reported as unowned; taking it over with `--adopt`
 * leaves `token` `undefined`, because no API can return its value.
 *
 * A token lives at most 6 months, and 6 months by default. A deploy after it expired replaces it,
 * and so does changing `instanceId`, `ttlDuration`, `rotateWhenChanged`, `projectId` or `region`.
 * A host holding the old value only sees the new one when it redeploys. With an explicit `name`
 * the old token is deleted first. A host that doesn't redeploy for 6 months loses access.
 *
 * See [STACKIT's AI Model Experiments docs](https://docs.stackit.cloud/products/data-and-ai/ai-model-experiments/).
 *
 * :::caution[Changing `instanceId`, `ttlDuration`, `rotateWhenChanged`, `projectId` or `region` replaces the Token]
 * So does a deploy after it expired. A host holding the old value only sees the new
 * one when it redeploys. With an explicit `name` the old token is deleted first.
 * :::
 *
 * ### Creating a Token
 * **Example:** A token with the default lifetime
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.ModelExperiments.Instance("Experiments", {});
 * const token = yield* Stackit.ModelExperiments.Token("Tracking", {
 *   instanceId: instance.instanceId,
 * });
 * ```
 *
 * **Example:** A named token that expires after a day
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.ModelExperiments.Instance("Experiments", {});
 * const token = yield* Stackit.ModelExperiments.Token("Ci", {
 *   instanceId: instance.instanceId,
 *   name: "ci",
 *   description: "Continuous integration",
 *   ttlDuration: "24h",
 *   labels: { env: "ci" },
 * });
 * ```
 *
 * ### Rotating a Token
 * **Example:** Replace the token by changing `rotateWhenChanged`
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.ModelExperiments.Instance("Experiments", {});
 * const token = yield* Stackit.ModelExperiments.Token("Tracking", {
 *   instanceId: instance.instanceId,
 *   rotateWhenChanged: { rotation: "2026-11" },
 * });
 * ```
 *
 * ### Using the Token in a Runtime
 * **Example:** Log a metric from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Clock from "effect/Clock";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Experiments = Stackit.ModelExperiments.Instance("Experiments", {});
 * export const Tracking = Experiments.pipe(
 *   Effect.flatMap((instance) =>
 *     Stackit.ModelExperiments.Token("Tracking", { instanceId: instance.instanceId }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const logMetric = yield* Stackit.ModelExperiments.LogMetric(yield* Tracking);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const timestamp = yield* Clock.currentTimeMillis;
 *         yield* logMetric({ run_id: "...", key: "loss", value: 0.5, timestamp });
 *         return HttpServerResponse.empty();
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ModelExperiments.LogMetricHttp)),
 * ) {}
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Changing `ttlDuration` makes a new token
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.ModelExperiments.Instance("Experiments", {});
 * // The API can't change a lifetime. A host bound to the token gets the new value on the same
 * // deploy; anything else holding the old value stops working.
 * const token = yield* Stackit.ModelExperiments.Token("Tracking", {
 *   instanceId: instance.instanceId,
 *   ttlDuration: "48h",
 * });
 * ```
 *
 * @resource
 * @product STACKIT AI Model Experiments
 * @category ModelExperiments
 */
export const Token = Resource<Token>("Stackit.ModelExperiments.Token");

type ApiToken = modelExperiments.TokenMetadata | modelExperiments.Token;

/** What a token carries over from before this observation. */
interface KnownToken {
  readonly token: Redacted.Redacted<string> | undefined;
  readonly adopted: boolean;
  readonly instanceUrl: string;
}

const toAttrs = (
  scope: ProjectScope,
  instanceId: string,
  token: ApiToken,
  known: KnownToken,
): TokenAttributes => ({
  tokenId: token.id,
  instanceId,
  projectId: scope.projectId,
  region: scope.region,
  instanceUrl: known.instanceUrl,
  token: known.token,
  adopted: known.adopted,
  name: token.name,
  description: token.description === "" ? undefined : token.description,
  state: token.state,
  validUntil: token.validUntil,
  labels: userAiLabels(token.labels),
});

/** A token, or `undefined` once it is gone. The API never returns its value here. */
const getTokenOrUndefined = (scope: ProjectScope, instanceId: string, tokenId: string) =>
  modelExperiments.getInstanceToken({ ...scopeRequest(scope), instanceId, tokenId }).pipe(
    Effect.map(({ token }) => token),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

/** An instance's live tokens, or none once the instance is gone. The API doesn't page this list. */
const listTokens = (scope: ProjectScope, instanceId: string) =>
  modelExperiments.listInstanceTokens({ ...scopeRequest(scope), instanceId }).pipe(
    Effect.map(({ tokens }) => tokens.filter((token) => token.state !== "deleting")),
    Effect.catchTag("NotFound", () => Effect.succeed<modelExperiments.TokenMetadata[]>([])),
  );

/** Wait until the token is `active`, and `applied` holds. */
const waitForActive = (
  scope: ProjectScope,
  instanceId: string,
  tokenId: string,
  applied: (token: modelExperiments.TokenMetadata) => boolean = () => true,
) =>
  waitFor({
    resource: `STACKIT Model Experiments token ${tokenId}`,
    // A 404 this soon after a create isn't taken as gone: the budget bounds the wait.
    read: getTokenOrUndefined(scope, instanceId, tokenId),
    ready: (token) => token?.state === "active" && applied(token),
    failed: (token) =>
      token?.state === "inactive" || token?.state === "deleting" ? token.state : undefined,
    state: (token) => token?.state,
    timeout: LIFECYCLE_TIMEOUT,
    interval: "2 seconds",
    maxInterval: "15 seconds",
  });

/** Delete a token and wait until it is gone. Idempotent. */
const deleteToken = (scope: ProjectScope, instanceId: string, tokenId: string) =>
  Effect.gen(function* () {
    const current = yield* getTokenOrUndefined(scope, instanceId, tokenId);
    if (current === undefined) return;
    if (current.state !== "deleting") {
      yield* modelExperiments
        .deleteInstanceToken({ ...scopeRequest(scope), instanceId, tokenId })
        .pipe(
          Effect.retry(conflictRetry),
          Effect.catchTag("NotFound", () => Effect.void),
        );
    }
    yield* waitUntilGone({
      resource: `STACKIT Model Experiments token ${tokenId}`,
      read: getTokenOrUndefined(scope, instanceId, tokenId),
      state: (token) => token.state,
      timeout: LIFECYCLE_TIMEOUT,
      interval: "2 seconds",
      maxInterval: "15 seconds",
    });
  });

export const TokenProvider = () =>
  Provider.succeed(Token, {
    stables: ["tokenId", "instanceId", "projectId", "region", "instanceUrl"],
    nuke: { dependsOn: ["Stackit.ModelExperiments.Instance"] },

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const instances = yield* listScopeInstances(scope);
      const found: TokenAttributes[] = [];
      for (const instance of instances.filter((item) => isAlchemyOwned(item.labels))) {
        const tokens = yield* listTokens(scope, instance.id);
        for (const token of tokens.filter((item) => isAlchemyOwned(item.labels))) {
          found.push(
            toAttrs(scope, instance.id, token, {
              token: undefined,
              adopted: false,
              instanceUrl: instance.url,
            }),
          );
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // A generated name carries the generation; an explicit one may not exist twice.
      const deleteFirst = rawProp<TokenProps>(news, "name") !== undefined;
      if (
        hasUnresolvedTrigger<TokenProps>(news, [
          "instanceId",
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
        resolved.instanceId !== output.instanceId ||
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
      // `read` doesn't run at plan for a created row: expiry is noticed here.
      const now = yield* Clock.currentTimeMillis;
      if (output.state === "inactive" || isPastValidUntil(output.validUntil, now)) {
        return { action: "replace", deleteFirst } as const;
      }
      // A value a crash lost: reconcile deletes the token and makes a new one.
      if (output.token === undefined) return { action: "update" } as const;
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId: generationId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const instanceId = output?.instanceId ?? olds?.instanceId;
      if (instanceId === undefined) return undefined;
      const instance = yield* getInstanceOrUndefined(scope, instanceId);
      if (instance === undefined) return undefined;
      const known: KnownToken = {
        token: output?.token,
        adopted: output?.adopted ?? false,
        instanceUrl: instance.url,
      };
      if (output !== undefined) {
        const byId = yield* getTokenOrUndefined(scope, instanceId, output.tokenId);
        if (byId !== undefined && byId.state !== "deleting") {
          return toAttrs(scope, instanceId, byId, known);
        }
      }
      const tokens = yield* listTokens(scope, instanceId);
      // A crashed create has neither state nor a previous generation, and any generation of this
      // logical id is ours. A replacement only owns its own.
      const generation = readGeneration({ instanceId: generationId, output, previous });
      const owned = yield* findOwnedAiItem(id, tokens, generation);
      if (owned !== undefined) return toAttrs(scope, instanceId, owned, known);
      const name = output?.name ?? olds?.name;
      const named = tokens.find((token) => token.name === name);
      if (named === undefined) return undefined;
      const attrs = toAttrs(scope, instanceId, named, known);
      // A token id is only unique on its instance, and an instance id per scope.
      const isPrevious =
        previous?.tokenId === named.id &&
        previous.instanceId === instanceId &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region;
      return isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId: generationId, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const instanceId = news.instanceId;
      const request = { ...scopeRequest(scope), instanceId };
      const name = news.name ?? (yield* createPhysicalName({ id, maxLength: NAME_MAX_LENGTH }));
      const labels = yield* desiredGenerationLabels(id, generationId, news.labels);
      // `output` only speaks for this token while it sits on the desired instance.
      const cached =
        output?.instanceId === instanceId &&
        output.projectId === scope.projectId &&
        output.region === scope.region
          ? output
          : undefined;

      // First, so nothing before the create's answer can fail and lose the value.
      const { instance } = yield* modelExperiments.getInstance(request);
      const instanceUrl = instance.url;

      // 1. Observe — by cached id, then by this generation's labels (a crashed create).
      let current: modelExperiments.TokenMetadata | undefined;
      if (cached !== undefined) {
        current = yield* getTokenOrUndefined(scope, instanceId, cached.tokenId);
      }
      if (current === undefined) {
        const tokens = yield* listTokens(scope, instanceId);
        current = yield* findOwnedAiItem(id, tokens, generationId);
      }
      // A delete in flight (an interrupted destroy): let it finish.
      if (current?.state === "deleting") {
        yield* deleteToken(scope, instanceId, current.id);
        current = undefined;
      }

      let value = current === undefined ? undefined : cached?.token;
      // No value and labels of this generation: Alchemy created it and a crash lost the value.
      // No value and no such labels: it was taken over with `--adopt`, nobody here can tell who
      // holds its value, and it is never recreated.
      const adopted =
        current !== undefined &&
        (cached?.adopted === true ||
          (value === undefined && !hasInstanceLabel(generationId, current.labels)));

      // A token with no known value, or an expired one, is useless to what it is bound to, and
      // can't be repaired.
      if (
        current !== undefined &&
        !adopted &&
        (value === undefined || current.state === "inactive")
      ) {
        yield* deleteToken(scope, instanceId, current.id);
        current = undefined;
        value = undefined;
      }

      // 2. Ensure — the response holds the only copy of the value. A token lost to a failed wait
      // is deleted: no state holds it.
      if (current === undefined) {
        const { token: created } = yield* modelExperiments.createInstanceToken({
          ...request,
          name,
          labels,
          ...(news.description !== undefined ? { description: news.description } : {}),
          ...(news.ttlDuration !== undefined ? { ttlDuration: news.ttlDuration } : {}),
        });
        const live = yield* waitForActive(scope, instanceId, created.id).pipe(
          Effect.onError(() => deleteToken(scope, instanceId, created.id).pipe(Effect.ignore)),
        );
        return toAttrs(scope, instanceId, live ?? created, {
          token: redactedValue(created.content),
          adopted: false,
          instanceUrl,
        });
      }
      const known: KnownToken = { token: value, adopted, instanceUrl };

      // An adopted token past its life has nothing to sync, and PATCH would refuse it.
      if (current.state === "inactive") return toAttrs(scope, instanceId, current, known);
      if (current.state !== "active") {
        current = (yield* waitForActive(scope, instanceId, current.id)) ?? current;
      }

      // 3. Sync — observed name, description and labels against the desired ones.
      const descriptionDrifted =
        news.description !== undefined && (current.description ?? "") !== news.description;
      const labelsDelta = labelPatch(current.labels, labels);
      if (current.name !== name || descriptionDrifted || labelsDelta !== undefined) {
        yield* modelExperiments
          .partialUpdateInstanceToken({
            ...request,
            tokenId: current.id,
            ...(current.name !== name ? { name } : {}),
            ...(descriptionDrifted ? { description: news.description } : {}),
            ...(labelsDelta !== undefined ? { labels: labelsDelta } : {}),
          })
          .pipe(Effect.retry(conflictRetry));
        // Waiting for the new values means a read from before the PATCH can't pass.
        current =
          (yield* waitForActive(
            scope,
            instanceId,
            current.id,
            (token) =>
              token.name === name &&
              (news.description === undefined || (token.description ?? "") === news.description),
          )) ?? current;
      }

      // 4. Return
      return toAttrs(scope, instanceId, current, known);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteToken(
        { projectId: output.projectId, region: output.region },
        output.instanceId,
        output.tokenId,
      );
    }),
  });
