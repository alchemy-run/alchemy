import * as b2bi from "@distilled.cloud/aws/b2bi";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { readB2biTags, syncB2biTags, toWireTags } from "./internal.ts";

export interface TransformerProps {
  /**
   * The name of the transformer.
   */
  name: string;
  /**
   * The transformer's processing state. Newly created transformers default
   * to `inactive`; set to `active` to make the transformer usable by a
   * capability.
   * @default "inactive"
   */
  status?: "active" | "inactive";
  /**
   * Describes the format of the source document (e.g. X12 EDI) and any
   * advanced options for parsing it.
   */
  inputConversion?: b2bi.InputConversion;
  /**
   * The mapping template (JSONATA or XSLT) that transforms the input
   * document into the output format.
   */
  mapping?: b2bi.Mapping;
  /**
   * Describes the format of the output document (e.g. X12 EDI) for outbound
   * transformers.
   */
  outputConversion?: b2bi.OutputConversion;
  /**
   * Locations of sample input and output documents used to test the
   * transformer.
   */
  sampleDocuments?: b2bi.SampleDocuments;
  /**
   * User-defined tags for the transformer.
   */
  tags?: Record<string, string>;
}

export interface Transformer extends Resource<
  "AWS.B2BI.Transformer",
  TransformerProps,
  {
    transformerId: string;
    transformerArn: string;
    name: string;
    status: string;
  },
  never,
  Providers
> {}

/**
 * An AWS B2B Data Interchange (B2BI) transformer. A transformer describes
 * how to convert inbound EDI documents to a target format (or the reverse)
 * using a mapping template. Transformers are credential-free and testable.
 * @resource
 * @section Creating a Transformer
 * @example Inbound X12 to JSON
 * ```typescript
 * const transformer = yield* B2BI.Transformer("X12ToJson", {
 *   name: "x12-to-json",
 *   status: "active",
 *   inputConversion: {
 *     fromFormat: "X12",
 *     formatOptions: { x12: { transactionSet: "X12_850", version: "VERSION_4010" } },
 *   },
 *   mapping: {
 *     templateLanguage: "JSONATA",
 *     template: "{ \"orderId\": transactionSets[0].St.transactionSetControlNumber }",
 *   },
 * });
 * ```
 */
export const Transformer = Resource<Transformer>("AWS.B2BI.Transformer");

const toAttrs = (
  r:
    | b2bi.GetTransformerResponse
    | b2bi.CreateTransformerResponse
    | b2bi.UpdateTransformerResponse,
) => ({
  transformerId: r.transformerId,
  transformerArn: r.transformerArn,
  name: r.name,
  status: r.status,
});

/** JSON fingerprint of the mutable transformer configuration. */
const spec = (props: TransformerProps): string =>
  JSON.stringify({
    inputConversion: props.inputConversion ?? null,
    mapping: props.mapping ?? null,
    outputConversion: props.outputConversion ?? null,
    sampleDocuments: props.sampleDocuments ?? null,
  });

export const TransformerProvider = () =>
  Provider.effect(
    Transformer,
    Effect.gen(function* () {
      const findByName = (name: string) =>
        b2bi.listTransformers.items({}).pipe(
          Stream.filter((s) => s.name === name),
          Stream.runHead,
          Effect.flatMap((head) =>
            head._tag === "Some"
              ? b2bi
                  .getTransformer({ transformerId: head.value.transformerId })
                  .pipe(
                    Effect.catchTag("ResourceNotFoundException", () =>
                      Effect.succeed(undefined),
                    ),
                  )
              : Effect.succeed(undefined),
          ),
        );

      return {
        stables: ["transformerId", "transformerArn"],

        read: Effect.fn(function* ({ id, olds, output }) {
          const found = output?.transformerId
            ? yield* b2bi
                .getTransformer({ transformerId: output.transformerId })
                .pipe(
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                )
            : yield* findByName(olds?.name ?? "");
          if (found === undefined) return undefined;
          const attrs = toAttrs(found);
          const tags = yield* readB2biTags(attrs.transformerArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredStatus = news.status ?? "inactive";

          // 1. Observe.
          let live = output?.transformerId
            ? yield* b2bi
                .getTransformer({ transformerId: output.transformerId })
                .pipe(
                  Effect.catchTag("ResourceNotFoundException", () =>
                    Effect.succeed(undefined),
                  ),
                )
            : yield* findByName(news.name);

          // 2. Ensure.
          if (live === undefined) {
            const created = yield* b2bi.createTransformer({
              name: news.name,
              inputConversion: news.inputConversion,
              mapping: news.mapping,
              outputConversion: news.outputConversion,
              sampleDocuments: news.sampleDocuments,
              tags: toWireTags(desiredTags),
            });
            live = yield* b2bi.getTransformer({
              transformerId: created.transformerId,
            });
          }

          // 3. Sync — converge name, config, and status. Newly created
          // transformers are inactive; a status change to active makes them
          // usable by a capability. An ACTIVE transformer rejects config
          // updates ("An active Transformer cannot be updated"), so a
          // config/name change on a live-active transformer must deactivate
          // first, apply the change, then restore the desired status.
          const configDrift = spec(live) !== spec(news);
          const nameDrift = live.name !== news.name;
          const statusDrift = live.status !== desiredStatus;
          if (configDrift || nameDrift) {
            // An active transformer must be deactivated before its config can
            // change. Deactivation is eventually consistent, so poll until
            // the transformer reports `inactive` before pushing the update.
            if (live.status === "active") {
              yield* b2bi.updateTransformer({
                transformerId: live.transformerId,
                status: "inactive",
              });
              yield* b2bi
                .getTransformer({ transformerId: live.transformerId })
                .pipe(
                  Effect.map((t) => t.status),
                  Effect.repeat({
                    until: (status) => status !== "active",
                    schedule: Schedule.fixed("2 seconds").pipe(
                      Schedule.both(Schedule.recurs(8)),
                    ),
                  }),
                );
            }
            // Config update carries NO status field (a status change in the
            // same call as a config change is rejected).
            yield* b2bi.updateTransformer({
              transformerId: live.transformerId,
              name: news.name,
              inputConversion: news.inputConversion,
              mapping: news.mapping,
              outputConversion: news.outputConversion,
              sampleDocuments: news.sampleDocuments,
            });
            // Restore the desired status separately.
            const updated = yield* b2bi.updateTransformer({
              transformerId: live.transformerId,
              status: desiredStatus,
            });
            live = { ...live, ...updated };
          } else if (statusDrift) {
            const updated = yield* b2bi.updateTransformer({
              transformerId: live.transformerId,
              status: desiredStatus,
            });
            live = { ...live, ...updated };
          }

          // 3b. Sync tags.
          yield* syncB2biTags(live.transformerArn, desiredTags);

          yield* session.note(live.transformerId);
          return toAttrs(live);
        }),

        delete: Effect.fn(function* ({ output }) {
          // A transformer must be inactive before deletion; deactivate first,
          // tolerating a resource that is already gone.
          yield* b2bi
            .updateTransformer({
              transformerId: output.transformerId,
              status: "inactive",
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.catch(() => Effect.void),
            );
          yield* b2bi
            .deleteTransformer({ transformerId: output.transformerId })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        list: () =>
          b2bi.listTransformers.items({}).pipe(
            Stream.mapEffect((s) =>
              b2bi.getTransformer({ transformerId: s.transformerId }).pipe(
                Effect.map(toAttrs),
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(undefined),
                ),
              ),
            ),
            Stream.filter((item) => item !== undefined),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          ),
      };
    }),
  );
