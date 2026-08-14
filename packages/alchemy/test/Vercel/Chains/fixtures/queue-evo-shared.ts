/**
 * Shared pieces of the QueueEvolution chain fixtures (DEPTH.md row 3).
 *
 * The chain deploys FOUR versions of the same logical Function
 * (`QueueEvoFn`), one per reconciliation cycle:
 *
 *   v1  Topic schema v1 + default subscribe options
 *   v2  same schema, subscribe option change (retryAfterSeconds)
 *   v3  Topic schema EVOLVED (optional `note` field) + a raw-JSON send
 *       route that emits an OLD-shape (v1) wire message
 *   v4  subscribe removed entirely — no consumer function in the deployment
 *
 * Each version lives in its own module because the deployed bundle is built
 * from the fixture file itself (`main: import.meta.url`) — a schema change
 * must change the code that ships to BOTH ends. This module holds what stays
 * identical across all four: the echo topic (readback channel), the `Echo`
 * row type, and the raw data-plane send helper used to simulate an
 * un-evolved producer.
 *
 * The echo topic's schema carries the optional `note` from the start so the
 * readback channel itself never confounds the Orders-schema evolution under
 * test.
 */
import { ambientOidcToken } from "@/Vercel/Queues/OidcToken.ts";
import { sendMessageRaw } from "@/Vercel/Queues/QueueData.ts";
import * as Vercel from "@/Vercel/index.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class Echoes extends Vercel.Topic<Echoes>()("alchemy-qevo-echoes", {
  schema: Schema.Struct({
    orderId: Schema.String,
    runId: Schema.String,
    note: Schema.optional(Schema.String),
    deliveryCount: Schema.Int,
    topicName: Schema.String,
    consumerGroup: Schema.String,
  }),
  region: "iad1",
  retentionSeconds: 300,
}) {}

export interface Echo {
  readonly orderId: string;
  readonly runId: string;
  readonly note?: string;
  readonly deliveryCount: number;
  readonly topicName: string;
  readonly consumerGroup: string;
}

/** Stable readback consumer group for the public `/received` drains. */
export const READBACK_GROUP = "alchemy-qevo-readback";

/** JSON diagnostics for a typed queue/schema error surfaced over HTTP. */
export const errorInfo = (error: {
  readonly _tag: string;
  readonly message?: unknown;
}): { readonly error: string; readonly message: string } => ({
  error: error._tag,
  message: String(error.message ?? ""),
});

/**
 * Send RAW JSON bytes into a topic from inside the deployed function —
 * ambient OIDC token, ambient deployment pin, NO schema encode. This is how
 * the chain proves an old-shape (pre-evolution) wire message still decodes
 * after the schema gains a field: the bytes on the wire are exactly what a
 * v1 producer would have sent.
 */
export const sendRawJson = (
  topic: { readonly topicName: string; readonly region: string },
  json: unknown,
) =>
  Effect.gen(function* () {
    const token = yield* ambientOidcToken;
    const deploymentId = yield* Effect.sync(
      () => process.env.VERCEL_DEPLOYMENT_ID,
    );
    if (deploymentId === undefined || deploymentId === "") {
      return yield* Effect.die(
        "sendRawJson: no ambient VERCEL_DEPLOYMENT_ID to pin the send",
      );
    }
    const body = yield* Effect.sync(() =>
      new TextEncoder().encode(JSON.stringify(json)),
    );
    return yield* sendMessageRaw({
      region: topic.region,
      topic: topic.topicName,
      token,
      deploymentId,
      body,
      contentType: "application/json",
      retentionSeconds: 300,
    });
  });
