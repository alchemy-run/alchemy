import { GrpcTransport } from "@distilled.cloud/core/grpc-transport";
import * as CloudflareSockets from "@distilled.cloud/core/grpc-transport-cloudflare-sockets";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";

/** Whether this code runs on workerd (a Cloudflare Worker or Durable Object). */
export const isWorkerd = (): boolean =>
  typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

/**
 * How Modal calls leave this runtime: `fetch`, and on a Cloudflare Worker,
 * distilled's `cloudflare:sockets` gRPC transport. `api.modal.com` is behind
 * Cloudflare, and a Worker's `fetch` to it takes Cloudflare's internal
 * Worker-to-site path, which resets Modal's gRPC upstream (`grpc-status: 14`).
 * Other HTTP calls (blob uploads, the user's own endpoints) keep `fetch`.
 */
export const ModalTransport: Layer.Layer<HttpClient.HttpClient> = Layer.mergeAll(
  FetchHttpClient.layer,
  Layer.effect(
    GrpcTransport,
    Effect.sync(() => (isWorkerd() ? CloudflareSockets.client : undefined)),
  ),
);
