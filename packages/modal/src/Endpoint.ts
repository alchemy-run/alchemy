import * as endpoint from "@distilled.cloud/modal/endpoint";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import {
  environmentNames,
  envNameOf,
  environmentOf,
  isGeneratedName,
  listAll,
  type EnvironmentInput,
  objectName,
} from "./internal.ts";
import { declarable } from "./internal/Declared.ts";
import type { Providers } from "./Providers.ts";

/** Provisioning failed, was cancelled, or didn't finish in time. */
export class EndpointProvisioningFailed extends Data.TaggedError(
  "Modal.EndpointProvisioningFailed",
)<{
  readonly endpointId: string;
  readonly status: string;
  readonly message: string;
}> {}

/** Where the model comes from. */
export type EndpointModel =
  /** A model from Modal's catalog, by Hugging Face repo id (`"Qwen/Qwen3-8B"`). */
  | { readonly repoId: string }
  /** A Hugging Face repo, with a token for gated or private models. */
  | {
      readonly huggingface: string;
      readonly revision?: string;
      readonly token?: string | Redacted.Redacted<string>;
      /** The catalog model it's derived from, for serving defaults. */
      readonly baseModel: string;
    }
  /** Weights on a Modal Volume. */
  | {
      readonly volume: { readonly volumeId: string };
      readonly path: string;
      /** The catalog model it's derived from, for serving defaults. */
      readonly baseModel: string;
    };

export type EndpointApi = "openai-chat-completions" | "openai-responses" | "anthropic-messages";

export interface EndpointProps {
  /**
   * Endpoint name, unique per environment. If omitted, one is generated from
   * the stack, stage and logical ID. Changing it replaces the endpoint.
   */
  name?: string;
  /** Environment the endpoint runs in. Changing it replaces the endpoint. */
  environment?: EnvironmentInput;
  /** The model to serve. Changing it replaces the endpoint. */
  model: EndpointModel;
  /**
   * APIs the endpoint speaks.
   * @default ["openai-chat-completions"]
   */
  apis?: EndpointApi[];
  /**
   * Inputs the model accepts.
   * @default ["text"]
   */
  inputs?: Array<"text" | "image" | "audio">;
  /**
   * `dedicated` runs on GPUs reserved for you (billed while running);
   * `shared` runs on Modal's shared pool.
   * @default "dedicated"
   */
  servingMode?: "dedicated" | "shared";
  /** Regions the model runs in. @default Modal picks */
  regions?: string[];
  /**
   * The region requests enter through. Changing it replaces the endpoint.
   * @default "us-west"
   */
  routingRegion?: string;
  /**
   * Serve without proxy authentication. Without it, callers send a
   * `Modal.WebhookToken` as `Modal-Key` / `Modal-Secret`, and Modal only
   * creates the endpoint once a webhook token with access to its environment
   * exists (`EndpointProxyTokenRequired` otherwise): deploy the token first.
   * @default false
   */
  unauthenticated?: boolean;
  /** Free-form description. */
  description?: string;
}

export interface EndpointAttributes {
  /** Endpoint ID. */
  endpointId: string;
  /** Endpoint name. */
  name: string;
  /** Environment name, or `undefined` for the workspace default. */
  environment: string | undefined;
  /** Base URL of the endpoint's APIs (`…/v1/chat/completions`, `…/v1/messages`). */
  url: string;
  /** Whether callers need a proxy auth token. */
  requiresAuth: boolean;
}

/**
 * A Modal Endpoint: a managed model server that speaks the OpenAI Chat
 * Completions, OpenAI Responses or Anthropic Messages API, from a catalog
 * model, a Hugging Face repo, or weights on a Modal Volume.
 *
 * Reconcile waits until the endpoint is live, which takes minutes while the
 * model loads. Modal can't change an endpoint in place, so any change
 * replaces it.
 *
 * :::caution
 * A dedicated endpoint reserves GPUs and is billed while it runs. Destroy it
 * (or use `servingMode: "shared"`) when you're done.
 * :::
 *
 * ### Serving a model
 * **Example:** A catalog model behind the OpenAI API
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 *
 * export const Qwen = Modal.Endpoint("Qwen", {
 *   model: { repoId: "Qwen/Qwen3-8B" },
 *   apis: ["openai-chat-completions", "anthropic-messages"],
 * });
 * ```
 *
 * **Example:** Fine-tuned weights from a Volume
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 *
 * export const Weights = Modal.Volume("Weights", {});
 * export const Tuned = Modal.Endpoint("Tuned", {
 *   model: { volume: Weights, path: "/checkpoints/final", baseModel: "Qwen/Qwen3-8B" },
 * });
 * ```
 *
 * ### Calling it
 * **Example:** From a Cloudflare Worker with `Modal.FetchServer`
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import * as HttpClientRequest from "effect/http/HttpClientRequest";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Qwen } from "./Qwen.ts";
 *
 * export default class Chat extends Cloudflare.Worker<Chat>()(
 *   "Chat",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // Creates a webhook token for the Worker and sends it as Modal's proxy auth.
 *     const qwen = yield* Modal.FetchServer(Qwen);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const response = yield* qwen.fetch(
 *           HttpClientRequest.post("/v1/chat/completions").pipe(
 *             HttpClientRequest.bodyJsonUnsafe({
 *               model: "Qwen/Qwen3-8B",
 *               messages: [{ role: "user", content: "hi" }],
 *             }),
 *           ),
 *         );
 *         return HttpServerResponse.json(yield* response.json);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.FetchServerHttp)),
 * ) {}
 * ```
 *
 * @resource
 * @product Endpoint
 */
export const Endpoint = declarable<Endpoint>()(Resource<Endpoint>("Modal.Endpoint"));

export type Endpoint = Resource<
  "Modal.Endpoint",
  EndpointProps,
  EndpointAttributes,
  never,
  Providers
>;

const API = {
  "openai-chat-completions": "ENDPOINT_API_SURFACE_OPENAI_CHAT_COMPLETIONS",
  "openai-responses": "ENDPOINT_API_SURFACE_OPENAI_RESPONSES",
  "anthropic-messages": "ENDPOINT_API_SURFACE_ANTHROPIC_MESSAGES",
} as const;

const INPUT = {
  text: "ENDPOINT_INPUT_MODALITY_TEXT",
  image: "ENDPOINT_INPUT_MODALITY_IMAGE",
  audio: "ENDPOINT_INPUT_MODALITY_AUDIO",
} as const;

const modelSource = (model: EndpointModel): endpoint.EndpointModelSource => {
  if ("repoId" in model) return { baseModelRepoId: model.repoId };
  if ("huggingface" in model) {
    return {
      custom: {
        baseModelRepoId: model.baseModel,
        huggingface: {
          repoId: model.huggingface,
          revision: model.revision,
          huggingfaceToken: model.token,
        },
      },
    };
  }
  const volume = model.volume as { readonly volumeId?: string };
  return {
    custom: {
      baseModelRepoId: model.baseModel,
      modalVolume: { volumeId: volume.volumeId ?? "", modelPath: model.path },
    },
  };
};

/** Modal's default routing region (`modal endpoint create`'s). */
const DEFAULT_ROUTING_REGION = "us-west";

/** Props compared for replacement (credentials and references by value). */
const identity = (news: EndpointProps) => ({
  environment: envNameOf(news.environment),
  model: modelSource(news.model),
  apis: news.apis ?? ["openai-chat-completions"],
  inputs: news.inputs ?? ["text"],
  servingMode: news.servingMode ?? "dedicated",
  regions: news.regions,
  routingRegion: news.routingRegion ?? DEFAULT_ROUTING_REGION,
  unauthenticated: news.unauthenticated ?? false,
  description: news.description,
});

export const EndpointProvider = () =>
  Provider.effect(
    Endpoint,
    Effect.gen(function* () {
      const info = Effect.fn(function* (endpointId: string) {
        return yield* endpoint
          .endpointGetInfo({ endpointId })
          .pipe(Effect.catchTag("EndpointNotFound", () => Effect.undefined));
      });

      const lookup = Effect.fn(function* (name: string, env: string | undefined) {
        const found = yield* endpoint
          .endpointGetByName({ name, environmentName: environmentOf(env) })
          .pipe(Effect.catchTag("EndpointNotFound", () => Effect.undefined));
        if (!found?.endpointId) return undefined;
        const details = yield* info(found.endpointId);
        if (
          !details?.info ||
          details.info.lifecycle?.status === "ENDPOINT_LIFECYCLE_STATUS_STOPPED"
        ) {
          return undefined;
        }
        return {
          endpointId: found.endpointId,
          name,
          environment: env,
          url: details.info.serviceUrl ?? "",
          requiresAuth: details.info.requiresProxyAuth ?? true,
        } satisfies EndpointAttributes;
      });

      /** Wait until live: model loads take minutes. */
      const waitLive = Effect.fn(function* (endpointId: string) {
        for (let attempt = 0; attempt < 120; attempt++) {
          const details = yield* info(endpointId);
          const status = details?.info?.status;
          if (status === "ENDPOINT_STATUS_LIVE") return details!;
          if (
            status === "ENDPOINT_STATUS_FAILED" ||
            status === "ENDPOINT_STATUS_CANCELLED" ||
            status === "ENDPOINT_STATUS_STOPPED"
          ) {
            return yield* new EndpointProvisioningFailed({
              endpointId,
              status,
              message: `Modal endpoint ${endpointId} ended provisioning as ${status}`,
            });
          }
          yield* Effect.sleep("15 seconds");
        }
        return yield* new EndpointProvisioningFailed({
          endpointId,
          status: "ENDPOINT_STATUS_PROVISIONING",
          message: `Modal endpoint ${endpointId} wasn't live after 30 minutes`,
        });
      });

      return {
        stables: ["endpointId", "name", "environment"],
        diff: Effect.fn(function* ({ id, news, olds, output }) {
          if (!isResolved(news)) return undefined;
          const name = yield* objectName(id, news.name);
          if (output !== undefined && name !== output.name) return { action: "replace" } as const;
          // Modal has no endpoint update: every change is a new endpoint.
          if (olds !== undefined && !deepEqual(identity(news), identity(olds))) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* objectName(id, olds?.name));
          const found = yield* lookup(name, output?.environment ?? envNameOf(olds?.environment));
          if (!found) return undefined;
          return output !== undefined || olds?.name === undefined ? found : Unowned(found);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.name ?? (yield* objectName(id, news.name));
          const env = envNameOf(news.environment);
          // Observe
          const existing = yield* lookup(name, env);
          let endpointId = existing?.endpointId;
          // Ensure
          if (endpointId === undefined) {
            yield* session.note(`Creating endpoint ${name}...`);
            const created = yield* endpoint
              .createEndpoint({
                name,
                description: news.description,
                environmentName: environmentOf(env),
                model: modelSource(news.model),
                apiSurfaces: (news.apis ?? ["openai-chat-completions"]).map((api) => API[api]),
                inputModalities: (news.inputs ?? ["text"]).map((input) => INPUT[input]),
                servingMode:
                  (news.servingMode ?? "dedicated") === "shared"
                    ? "ENDPOINT_SERVING_MODE_SHARED"
                    : "ENDPOINT_SERVING_MODE_DEDICATED",
                computeRegion: news.regions
                  ? { explicit: { regions: news.regions } }
                  : { auto: {} },
                // Modal routes an endpoint through exactly one region.
                proxyRegions: [news.routingRegion ?? DEFAULT_ROUTING_REGION],
                unauthenticated: news.unauthenticated ?? false,
                sharedEndpointNoticeAcknowledged: news.servingMode === "shared" ? true : undefined,
              })
              .pipe(
                // An endpoint creates an App, and Modal rate-limits App
                // creation per workspace; wait it out, as `Modal.App` does.
                Effect.retry({
                  while: (e) => e._tag === "TooManyRequests",
                  schedule: Schedule.spaced("5 seconds"),
                  times: 12,
                }),
                Effect.catchTag("EndpointAlreadyExists", () =>
                  lookup(name, env).pipe(
                    Effect.map((found) => ({ endpointId: found?.endpointId })),
                  ),
                ),
              );
            endpointId = created.endpointId;
          }
          if (!endpointId) {
            return yield* new EndpointProvisioningFailed({
              endpointId: "",
              status: "ENDPOINT_STATUS_UNSPECIFIED",
              message: `Modal returned no endpoint for ${name}`,
            });
          }
          yield* session.note(`Waiting for endpoint ${name} to go live...`);
          const live = yield* waitLive(endpointId);
          return {
            endpointId,
            name,
            environment: env,
            url: live.info?.serviceUrl ?? "",
            requiresAuth: live.info?.requiresProxyAuth ?? true,
          };
        }),
        list: Effect.fn(function* () {
          const envs = yield* environmentNames;
          const all: EndpointAttributes[] = [];
          for (const env of envs) {
            const items = yield* listAll(
              (pagination) =>
                endpoint
                  .listEndpoint({ environmentName: env, pagination })
                  .pipe(Effect.map((response) => response.items ?? [])),
              (item) => item.updatedAt,
            );
            for (const item of items) {
              if (!item.endpointId || !isGeneratedName(item.name)) continue;
              const found = yield* lookup(item.name ?? "", env);
              if (found) all.push(found);
            }
          }
          return all;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* endpoint
            .stopEndpoint({ endpointId: output.endpointId, source: "ENDPOINT_STOP_SOURCE_CLI" })
            .pipe(Effect.catchTag("EndpointNotFound", () => Effect.void));
        }),
      };
    }),
  );
