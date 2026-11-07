import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { EventarcEventSource } from "../Eventarc/EventSource.ts";
import type { Database } from "./Database.ts";
import {
  DocumentEventSource,
  toDocumentEvent,
  type DocumentEventKind,
  type DocumentEventsHandler,
  type DocumentEventSourceProps,
  type DocumentEventSourceService,
} from "./DocumentEventSource.ts";

/**
 * Implementation of `GCP.Firestore.DocumentEventSource` over Eventarc.
 *
 * Deploy-time: one Eventarc trigger per change kind
 * (`google.cloud.firestore.document.v1.<kind>`), in the database's
 * location, filtered on the database id and the document path pattern,
 * with protobuf payloads (decoded for the handler). Delivery is delegated to the provided
 * `GCP.Eventarc.EventSource` implementation (`GCP.Run.EventarcEventSource`).
 *
 * ### Delivering document changes
 * **Example:** To a Cloud Run service
 * ```typescript
 * Effect.gen(function* () {
 *   yield* GCP.Firestore.consumeDocumentEvents(
 *     database,
 *     { document: "users/{userId}" },
 *     (event) => Effect.log(`${event.kind} ${event.document}`),
 *   );
 * }).pipe(
 *   Effect.provide(
 *     GCP.Firestore.DocumentEventSourceLive.pipe(Layer.provideMerge(GCP.Run.EventarcEventSource)),
 *   ),
 * );
 * ```
 *
 * @layer
 * @provides GCP.Firestore.DocumentEventSource
 * @category Firestore
 */
export const DocumentEventSourceLive = Layer.effect(
  DocumentEventSource,
  Effect.gen(function* () {
    const source = yield* EventarcEventSource;

    return Effect.fn(function* <Req = never>(
      database: Database,
      props: DocumentEventSourceProps,
      process: DocumentEventsHandler<Req>,
    ) {
      const kinds: DocumentEventKind[] = props.kinds ?? ["written"];
      for (const kind of kinds) {
        const id = `${database.LogicalId}-${kind}`;
        yield* source(
          id,
          {
            location: database.location,
            // Firestore events come only as protobuf.
            eventDataContentType: "application/protobuf",
            path: props.path ? `${props.path}/${kind}` : undefined,
            eventFilters: [
              { attribute: "type", value: `google.cloud.firestore.document.v1.${kind}` },
              { attribute: "database", value: database.databaseId },
              { attribute: "document", value: props.document, operator: "match-path-pattern" },
            ],
          },
          (event) => process(toDocumentEvent(props.document, event)),
        );
      }
    }) as DocumentEventSourceService;
  }),
);
