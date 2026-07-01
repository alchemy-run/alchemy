import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import type { Bucket } from "./Bucket.ts";
import type {
  BucketNotification,
  NotificationsProps,
} from "./BucketNotifications.ts";
import type { S3EventType } from "./S3Event.ts";

/** @binding */
export interface BucketEventSource extends Binding.Service<
  BucketEventSource,
  "BucketNotificationStream",
  BucketEventSourceService
> {}

export const BucketEventSource = Binding.Service<BucketEventSource>(
  "BucketNotificationStream",
);

export type BucketEventSourceService = <
  Events extends S3EventType[],
  StreamReq = never,
  Req = never,
>(
  bucket: Bucket,
  props: NotificationsProps<Events>,
  process: (
    stream: Stream.Stream<BucketNotification, never, StreamReq>,
  ) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;
