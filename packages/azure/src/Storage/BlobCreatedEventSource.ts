import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import type { BlobContainer } from "./BlobContainer.ts";

/** A blob was created or replaced (`Microsoft.Storage.BlobCreated`). */
export interface BlobCreatedEvent {
  /** Name of the blob inside its container, e.g. `reports/2026.json`. */
  blobName: string;
  /** Container that holds the blob. */
  containerName: string;
  /** Full blob URL. */
  url: string;
  /** Size in bytes. */
  contentLength: number | undefined;
  /** Content type of the blob. */
  contentType: string | undefined;
  /** ETag of the new blob. */
  eTag: string | undefined;
  /** When the event happened. */
  eventTime: string | undefined;
  /** The raw Event Grid event. */
  event: Record<string, unknown>;
}

export interface BlobCreatedEventSourceProps {
  /** Deliver only blobs whose name starts with this prefix (e.g. `uploads/`). */
  prefix?: string;
  /** Deliver only blobs whose name ends with this suffix (e.g. `.png`). */
  suffix?: string;
  /**
   * Name of the trigger function on the host (letters, digits, `_`, `-`).
   * @default `blob-<container logical ID>`
   */
  functionName?: string;
}

export type BlobCreatedEventSourceService = <Req = never>(
  container: BlobContainer,
  props: BlobCreatedEventSourceProps,
  handler: (event: BlobCreatedEvent) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void>;

/**
 * Event source that runs a handler whenever a blob is created or replaced
 * in a {@link BlobContainer}. Events travel through Event Grid (the storage
 * account's system topic), so the handler gets the event, not the blob's
 * bytes: read the blob with a `BlobContainerRead` binding when you need it.
 *
 * Consume it with {@link consumeBlobCreated} and provide the host's
 * implementation: `Azure.Functions.BlobCreatedEventSource` (an Event Grid
 * subscription delivering to a native `eventGridTrigger` function).
 *
 * ### Reacting to Uploads
 * **Example:** Log each new `.png` under `uploads/`
 * ```typescript
 * yield* Azure.Storage.consumeBlobCreated(
 *   images,
 *   { prefix: "uploads/", suffix: ".png" },
 *   (event) => Effect.log(`${event.blobName}: ${event.contentLength} bytes`),
 * );
 * // …provided with Effect.provide(Azure.Functions.BlobCreatedEventSource)
 * ```
 *
 * @binding
 * @category Storage
 */
export interface BlobCreatedEventSource extends Binding.Service<
  BlobCreatedEventSource,
  "Azure.Storage.BlobCreatedEventSource",
  BlobCreatedEventSourceService
> {}

export const BlobCreatedEventSource = Binding.Service<BlobCreatedEventSource>(
  "Azure.Storage.BlobCreatedEventSource",
);

/**
 * Run `handler` for every blob created in `container`.
 *
 * @example
 * ```typescript
 * yield* Azure.Storage.consumeBlobCreated(uploads, (event) => Effect.log(event.url));
 * ```
 */
export function consumeBlobCreated<C extends BlobContainer, Req = never, ContainerReq = never>(
  container: C | Effect.Effect<C, never, ContainerReq>,
  handler: (event: BlobCreatedEvent) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, BlobCreatedEventSource | ContainerReq>;
export function consumeBlobCreated<C extends BlobContainer, Req = never, ContainerReq = never>(
  container: C | Effect.Effect<C, never, ContainerReq>,
  props: BlobCreatedEventSourceProps,
  handler: (event: BlobCreatedEvent) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, BlobCreatedEventSource | ContainerReq>;
export function consumeBlobCreated<C extends BlobContainer, Req = never, ContainerReq = never>(
  container: C | Effect.Effect<C, never, ContainerReq>,
  propsOrHandler:
    | BlobCreatedEventSourceProps
    | ((event: BlobCreatedEvent) => Effect.Effect<void, never, Req>),
  maybeHandler?: (event: BlobCreatedEvent) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, BlobCreatedEventSource | ContainerReq> {
  const [props, handler] =
    typeof propsOrHandler === "function"
      ? [{} as BlobCreatedEventSourceProps, propsOrHandler]
      : [propsOrHandler, maybeHandler!];
  const resolved = Effect.isEffect(container) ? container : Effect.succeed(container);
  return resolved.pipe(
    Effect.flatMap((value) =>
      BlobCreatedEventSource.use((source) => source(value, props, handler)),
    ),
  );
}
