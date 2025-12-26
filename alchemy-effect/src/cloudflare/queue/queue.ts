import { Resource } from "../../resource.ts";

/**
 * Settings for a Cloudflare Queue
 */
export type QueueSettings = {
  /**
   * Number of seconds to delay delivery of all messages to consumers.
   * Queue will not deliver messages until this time has elapsed.
   */
  deliveryDelay?: number;

  /**
   * Indicates if message delivery to consumers is currently paused.
   * If true, the queue will not deliver messages to consumers.
   */
  deliveryPaused?: boolean;

  /**
   * Number of seconds after which an unconsumed message will be deleted.
   * Messages will be automatically deleted after this time.
   */
  messageRetentionPeriod?: number;
};

export type QueueProps = {
  /**
   * Name of the queue.
   * @default Generated from physical name
   */
  name?: string;

  /**
   * Settings for the queue.
   * These can be updated after queue creation.
   */
  settings?: QueueSettings;

  /**
   * Whether to adopt an existing queue with the same name if it exists.
   * If true and a queue with the same name exists, it will be adopted
   * rather than creating a new one.
   * @default false
   */
  adopt?: boolean;

  /**
   * Whether to delete the queue when the resource is destroyed.
   * If set to false, the queue will remain but the resource will be
   * removed from state.
   * @default true
   */
  delete?: boolean;
};

export type QueueAttr<Props extends QueueProps> = {
  /**
   * The unique ID of the queue (UUID)
   */
  queueId: string;

  /**
   * The name of the queue
   */
  queueName: Props["name"] extends string ? Props["name"] : string;

  /**
   * The account ID the queue belongs to
   */
  accountId: string;

  /**
   * Queue settings
   */
  settings: Props["settings"] extends QueueSettings
    ? Props["settings"]
    : QueueSettings | undefined;

  /**
   * Time when the queue was created
   */
  createdOn: string;

  /**
   * Time when the queue was last modified
   */
  modifiedOn: string;
};

export interface Queue<
  ID extends string = string,
  Props extends QueueProps = QueueProps,
> extends Resource<"Cloudflare.Queue", ID, Props, QueueAttr<Props>, Queue> {}

export const Queue = Resource<{
  <const ID extends string, const Props extends QueueProps>(
    id: ID,
    props?: Props,
  ): Queue<ID, Props>;
}>("Cloudflare.Queue");
