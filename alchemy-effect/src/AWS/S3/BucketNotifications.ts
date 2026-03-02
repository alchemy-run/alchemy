import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { Bucket } from "./Bucket.ts";
import { BucketEventSource } from "./BucketEventSource.ts";
import type { S3EventType } from "./S3Event.ts";

export type BucketNotification = {
  type: S3EventType;
  bucket: string;
  key: string;
  size: number;
  eTag: string;
};

export interface NotificationsProps<Events extends S3EventType[]> {
  events?: Events;
}

export const notifications = <
  B extends Bucket,
  const Events extends S3EventType[] = S3EventType[],
>(
  bucket: B,
  props: NotificationsProps<Events> = {},
) => ({
  subscribe: <Req = never, StreamReq = never>(
    process: (
      stream: Stream.Stream<BucketNotification, never, StreamReq>,
    ) => Effect.Effect<void, never, Req>,
  ) =>
    BucketEventSource.asEffect().pipe(
      Effect.flatMap((source) => source(bucket, props, process)),
    ),
});
