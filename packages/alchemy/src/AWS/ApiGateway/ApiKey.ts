import { Region } from "@distilled.cloud/aws/Region";
import * as ag from "@distilled.cloud/aws/api-gateway";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, hasAlchemyTags, tagRecord } from "../../Tags.ts";

import { apiKeyArn, syncTags } from "./common.ts";

export interface ApiKeyProps {
  /**
   * Friendly name for the API key.
   *
   * If omitted, Alchemy generates a deterministic physical name from the
   * stack, stage, logical ID, and instance ID.
   */
  name?: string;
  /**
   * Human-readable description shown in API Gateway.
   */
  description?: string;
  /**
   * Whether clients can use the key.
   *
   * @default true
   */
  enabled?: boolean;
  /**
   * Appends a distinct suffix to the generated key value when AWS generates it.
   */
  generateDistinctId?: boolean;
  /**
   * Write-only value when creating; never stored in resource state or outputs.
   * Wrap with `Redacted.make` so state encoding preserves redaction.
   */
  value?: Redacted.Redacted<string>;
  /**
   * Stage associations to attach directly to this API key.
   */
  stageKeys?: ag.StageKey[];
  /**
   * External customer identifier associated with the key.
   */
  customerId?: string;
  /**
   * User-defined tags. Alchemy internal tags are merged automatically.
   */
  tags?: Record<string, string>;
}

export interface ApiKey extends Resource<
  "AWS.ApiGateway.ApiKey",
  ApiKeyProps,
  {
    id: string;
    name: string | undefined;
    enabled: boolean | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * API Gateway API key for usage plans and `apiKeyRequired` methods.
 *
 * @section API keys
 * @example Generated key
 * ```typescript
 * const key = yield* ApiGateway.ApiKey("PartnerKey", {
 *   generateDistinctId: true,
 * });
 * ```
 */
const ApiKeyResource = Resource<ApiKey>("AWS.ApiGateway.ApiKey");

export { ApiKeyResource as ApiKey };

const resolvedValue = (value: Redacted.Redacted<string> | undefined) =>
  value ? Redacted.value(value) : undefined;

const generatedName = (id: string, props: ApiKeyProps) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({
        id,
        maxLength: 128,
      });

const readByName = Effect.fn(function* (id: string, name: string) {
  const keys = yield* ag.getApiKeys
    .items({ nameQuery: name, limit: 500, includeValues: false })
    .pipe(Stream.runCollect);

  for (const key of keys) {
    if (key.name !== name || !key.id) continue;
    if (yield* hasAlchemyTags(id, key.tags)) {
      return key;
    }
  }
  return undefined;
});

export const ApiKeyProvider = () =>
  Provider.effect(
    ApiKeyResource,
    Effect.gen(function* () {
      const awsRegion = yield* Region;

      return {
        stables: ["id"] as const,
        diff: Effect.fn(function* ({ news: newsIn, olds }) {
          if (!isResolved(newsIn)) return;
          const news = newsIn as ApiKeyProps;
          if (
            // API Gateway never returns the key value after create, so rotating
            // a user-supplied value is modeled as replacement instead of patch.
            resolvedValue(news.value) !== resolvedValue(olds.value) ||
            news.customerId !== olds.customerId
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.id) return undefined;
          const k = yield* ag
            .getApiKey({ apiKey: output.id, includeValue: false })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!k?.id) return undefined;
          return {
            id: k.id,
            name: k.name,
            enabled: k.enabled,
            tags: tagRecord(k.tags),
          };
        }),
        create: Effect.fn(function* ({ id, news: newsIn, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("ApiKey props were not resolved");
          }
          const news = newsIn as ApiKeyProps;
          const name = yield* generatedName(id, news);
          const internalTags = yield* createInternalTags(id);
          const allTags = { ...news.tags, ...internalTags };

          const k = yield* ag
            .createApiKey({
              name,
              description: news.description,
              enabled: news.enabled,
              generateDistinctId: news.generateDistinctId,
              value: resolvedValue(news.value),
              stageKeys: news.stageKeys,
              customerId: news.customerId,
              tags: allTags,
            })
            .pipe(
              Effect.catchTag("ConflictException", () =>
                Effect.gen(function* () {
                  const existing = yield* readByName(id, name);
                  if (existing) return existing;
                  return yield* Effect.fail(
                    new ag.ConflictException({
                      message: `API key '${name}' already exists and is not managed by alchemy`,
                    }),
                  );
                }),
              ),
            );
          if (!k.id) return yield* Effect.die("createApiKey missing id");
          yield* session.note(`Created API key ${k.id}`);
          const full = yield* ag.getApiKey({
            apiKey: k.id,
            includeValue: false,
          });
          if (!full.id) return yield* Effect.die("getApiKey missing id");
          return {
            id: full.id,
            name: full.name,
            enabled: full.enabled,
            tags: tagRecord(full.tags),
          };
        }),
        update: Effect.fn(function* ({ id, news: newsIn, output, session }) {
          if (!isResolved(newsIn)) {
            return yield* Effect.die("ApiKey props were not resolved");
          }
          const news = newsIn as ApiKeyProps;
          const patches: ag.PatchOperation[] = [];
          // Generated names are stable physical names; only patch when the user
          // explicitly supplies a new name.
          if (news.name !== undefined && news.name !== output.name) {
            patches.push({
              op: "replace",
              path: "/name",
              value: news.name ?? "",
            });
          }
          if (news.description !== undefined) {
            patches.push({
              op: "replace",
              path: "/description",
              value: news.description ?? "",
            });
          }
          if (news.enabled !== undefined && news.enabled !== output.enabled) {
            patches.push({
              op: "replace",
              path: "/enabled",
              value: String(news.enabled),
            });
          }
          if (patches.length > 0) {
            yield* ag.updateApiKey({
              apiKey: output.id,
              patchOperations: patches,
            });
          }

          const internalTags = yield* createInternalTags(id);
          const newTags = { ...news.tags, ...internalTags };
          if (!deepEqual(output.tags, newTags)) {
            yield* syncTags({
              resourceArn: apiKeyArn(awsRegion, output.id),
              oldTags: output.tags,
              newTags,
            });
          }

          yield* session.note(`Updated API key ${output.id}`);
          const full = yield* ag.getApiKey({
            apiKey: output.id,
            includeValue: false,
          });
          return {
            id: output.id,
            name: full.name,
            enabled: full.enabled,
            tags: tagRecord(full.tags),
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* ag
            .deleteApiKey({ apiKey: output.id })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
          yield* session.note(`Deleted API key ${output.id}`);
        }),
      };
    }),
  );
