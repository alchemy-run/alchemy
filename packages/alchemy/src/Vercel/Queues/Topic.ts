import type * as Schema from "effect/Schema";

export const TopicTypeId = "Vercel.Topic" as const;
export type TopicTypeId = typeof TopicTypeId;

/**
 * How sends and receives on a topic are partitioned across deployments.
 *
 * Vercel partitions queue visibility by `Vqs-Deployment-Id` (live-verified):
 * a message sent pinned to one deployment is invisible to receivers pinned to
 * another (or to unpinned receivers), and vice versa.
 *
 * - `"deployment"` (Vercel's default behavior): sends and receives pin
 *   `Vqs-Deployment-Id` from the ambient `VERCEL_DEPLOYMENT_ID` (or an
 *   explicit `deploymentId` client option).
 * - `"shared"`: opt out of pinning — messages live in the topic's shared
 *   (unpinned) partition, visible to any unpinned consumer.
 */
export type TopicPartition = "deployment" | "shared";

/** Vercel region codes look like `iad1`, `lhr1`, `fra1`. */
const REGION_PATTERN = /^[a-z]{2,5}[0-9]{1,2}$/;

export interface TopicOptions<S extends Schema.Top> {
  /**
   * Payload schema (`effect/Schema`). Types the producer's `send` and the
   * consumer's decoded payload from one declaration; values are encoded on
   * send and decoded on receive at the queue boundary.
   */
  readonly schema: S;
  /**
   * Region the topic is pinned to (e.g. `"iad1"`). Topics are region-scoped
   * on the platform; the region picks the data-plane endpoint
   * (`https://{region}.vercel-queue.com`), so producer and consumer can
   * never disagree.
   */
  readonly region: string;
  /**
   * Default retention in seconds applied to every send (`Vqs-Retention-Seconds`).
   * Messages expire on their own — there is no delete API. Max 7 days.
   */
  readonly retentionSeconds?: number;
  /**
   * Default delivery delay in seconds applied to every send
   * (`Vqs-Delay-Seconds`).
   */
  readonly delaySeconds?: number;
  /**
   * Deployment-partitioning mode for sends/receives on this topic.
   * @default "deployment"
   */
  readonly partition?: TopicPartition;
}

/**
 * The static shape of a Topic value — what `SendMessage`/`ReceiveMessages`
 * accept. The class produced by {@link Topic} satisfies this on its static
 * side, so the class itself is the value you pass around.
 */
export interface Topic<S extends Schema.Top = Schema.Top> {
  readonly [TopicTypeId]: TopicTypeId;
  /** The topic name on the platform (implicit — created on first send). */
  readonly topicName: string;
  /** Payload schema; see {@link TopicOptions.schema}. */
  readonly schema: S;
  /** Region the topic is pinned to; see {@link TopicOptions.region}. */
  readonly region: string;
  /** Default send retention in seconds. */
  readonly retentionSeconds?: number | undefined;
  /** Default send delay in seconds. */
  readonly delaySeconds?: number | undefined;
  /** Deployment-partitioning mode. */
  readonly partition: TopicPartition;
}

export interface TopicClass<
  Name extends string,
  S extends Schema.Top,
> extends Topic<S> {
  new (_: never): Topic<S>;
  readonly topicName: Name;
}

export const isTopic = (value: unknown): value is Topic =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as { [TopicTypeId]?: unknown })[TopicTypeId] === TopicTypeId;

/**
 * A typed Vercel queue topic — a config **value**, not a lifecycle Resource.
 *
 * Vercel topics have no lifecycle: nothing to create, list, or delete —
 * a topic springs into existence on first send, is scoped to one project and
 * region, and its messages expire on their own (≤7 days). So `Topic` has no
 * provider, no state row, and never appears in a plan. Only its *uses*
 * materialize: the env refs a producer binding injects, and (in a later
 * wave) the consumer trigger `subscribe` lowers into deployment config.
 *
 * The value is the single home for the payload schema, the region pin, and
 * send defaults (retention, delay, deployment partitioning) — declared once,
 * inherited by both ends.
 *
 * @section Declaring a Topic
 * @example Class form (importable from function files)
 * ```typescript
 * import * as Vercel from "alchemy/Vercel";
 * import * as Schema from "effect/Schema";
 *
 * export class Orders extends Vercel.Topic<Orders>()("orders", {
 *   schema: Schema.Struct({ orderId: Schema.String, amountCents: Schema.Int }),
 *   region: "iad1",
 * }) {}
 * ```
 *
 * @example Value form
 * ```typescript
 * const Orders = Vercel.Topic()("orders", {
 *   schema: Schema.Struct({ orderId: Schema.String }),
 *   region: "iad1",
 *   retentionSeconds: 3600,
 * });
 * ```
 */
export const Topic =
  <Self = never>() =>
  <const Name extends string, S extends Schema.Top>(
    topicName: Name,
    options: TopicOptions<S>,
  ): TopicClass<Name, S> => {
    if (!REGION_PATTERN.test(options.region)) {
      throw new Error(
        `Vercel.Topic(${JSON.stringify(topicName)}): invalid region ${JSON.stringify(
          options.region,
        )} — expected a Vercel region code like "iad1" or "lhr1"`,
      );
    }
    class Base {
      static readonly [TopicTypeId]: TopicTypeId = TopicTypeId;
      static readonly topicName = topicName;
      static readonly schema = options.schema;
      static readonly region = options.region;
      static readonly retentionSeconds = options.retentionSeconds;
      static readonly delaySeconds = options.delaySeconds;
      static readonly partition: TopicPartition =
        options.partition ?? "deployment";
    }
    return Base as unknown as TopicClass<Name, S>;
  };
