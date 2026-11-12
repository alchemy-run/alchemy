import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type { UsageExample } from "@distilled.cloud/starburst-galaxy/data_product_usage_example";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  changedFields,
  DATA_DOMAIN_NAME,
  findFirst,
  hasChanges,
  ownership,
  physicalName,
} from "../internal.ts";
import type { Providers } from "../Providers.ts";

export interface DataProductUsageExampleProps {
  /** ID of the data product the example belongs to. Changing it replaces the example. */
  readonly dataProductId: string;
  /**
   * Example title. Renaming updates the example in place.
   * @default generated from the stack, logical id and stage
   */
  readonly name?: string;
  /** The example query (SQL). */
  readonly code: string;
  /** What the example shows. */
  readonly description?: string;
  /** A natural-language question the example answers, for Galaxy's AI assistant. */
  readonly suggestedPrompt?: string;
}

export interface DataProductUsageExampleAttributes {
  /** Galaxy's usage example ID (`dpue-…`). */
  readonly usageExampleId: string;
  /** The data product the example belongs to. */
  readonly dataProductId: string;
  /** Example title. */
  readonly name: string;
  /** The example query. */
  readonly code: string;
  /** What the example shows. */
  readonly description: string | undefined;
  /** The question the example answers, if set. */
  readonly suggestedPrompt: string | undefined;
}

export type DataProductUsageExample = Resource<
  "StarburstGalaxy.DataProductUsageExample",
  DataProductUsageExampleProps,
  DataProductUsageExampleAttributes,
  never,
  Providers
>;

/** Galaxy accepted a usage example create but the example could not be read back. */
export class DataProductUsageExampleNotResolved extends Data.TaggedError(
  "StarburstGalaxy.DataProductUsageExampleNotResolved",
)<{ readonly exampleName: string }> {
  override get message() {
    return `Usage example "${this.exampleName}" could not be found after it was created`;
  }
}

/**
 * An example query shown on a Starburst Galaxy data product, so people
 * browsing the catalog see how to use it.
 *
 * Title, query, description and prompt update in place; moving the example
 * to another data product replaces it. Galaxy has no read operation for one
 * example: it is found on its product's list, by ID or by its generated title.
 *
 * @see https://docs.starburst.io/starburst-galaxy/working-with-data/data-products/manage-data-products.html
 *
 * ### Adding an example query
 * **Example:** The top customers by spend
 * ```typescript
 * const shop = StarburstGalaxy.PostgresqlCatalog.lookup({ name: "shop" });
 * const orders = yield* StarburstGalaxy.DataProduct("Orders", {
 *   summary: "Every order placed in the shop",
 *   catalogId: shop.catalogId,
 *   schemaName: "orders",
 * });
 * yield* StarburstGalaxy.DataProductUsageExample("TopCustomers", {
 *   dataProductId: orders.dataProductId,
 *   name: "Top customers",
 *   code: "SELECT customer, sum(amount) AS spend FROM shop.orders.orders GROUP BY 1 ORDER BY 2 DESC LIMIT 10",
 *   suggestedPrompt: "Who are our biggest customers?",
 * });
 * ```
 *
 * @resource
 * @product Data products
 */
export const DataProductUsageExample = Resource<DataProductUsageExample>(
  "StarburstGalaxy.DataProductUsageExample",
);

const toAttributes = (example: UsageExample): DataProductUsageExampleAttributes => ({
  usageExampleId: example.usageExampleId,
  dataProductId: example.dataProductId,
  name: example.name,
  code: example.code,
  description: example.description,
  suggestedPrompt: example.suggestedPrompt,
});

/** The examples of a product; none when the product is gone. */
const examplesOf = (dataProductId: string) =>
  galaxy.dataProductUsageExample.listDataProductUsageExamples
    .items({ dataProductId })
    .pipe(Stream.catchTag("NotFound", () => Stream.empty));

const observe = Effect.fn(function* (
  dataProductId: string,
  usageExampleId: string | undefined,
  name: string,
) {
  return yield* findFirst(examplesOf(dataProductId), (example) =>
    usageExampleId !== undefined
      ? example.usageExampleId === usageExampleId
      : example.name === name,
  );
});

export const DataProductUsageExampleProvider = () =>
  Provider.succeed(DataProductUsageExample, {
    stables: ["usageExampleId", "dataProductId"],

    nuke: { dependsOn: ["StarburstGalaxy.DataProduct"] },

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      if (news.dataProductId !== olds.dataProductId) return { action: "replace" } as const;
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const name = output?.name ?? (yield* physicalName(id, olds?.name, DATA_DOMAIN_NAME));
      const example = yield* observe(
        output?.dataProductId ?? olds.dataProductId,
        output?.usageExampleId,
        name,
      );
      if (example === undefined) return undefined;
      return ownership(toAttributes(example), {
        output,
        explicitName: olds?.name,
        previous,
        key: "usageExampleId",
      });
    }),

    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const name = yield* physicalName(id, news.name, DATA_DOMAIN_NAME);
      const desired = {
        name,
        code: news.code,
        description: news.description ?? "",
        suggestedPrompt: news.suggestedPrompt,
      };

      // Observe: by ID when known, else by title on the product's list.
      let example =
        (output === undefined
          ? undefined
          : yield* observe(news.dataProductId, output.usageExampleId, name)) ??
        (yield* observe(news.dataProductId, undefined, name));

      // Ensure
      if (example === undefined) {
        yield* session.note(`Creating usage example ${name}...`);
        const created = yield* galaxy.dataProductUsageExample
          .createDataProductUsageExample({ ...desired, dataProductId: news.dataProductId })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        example = created ?? (yield* observe(news.dataProductId, undefined, name));
        if (example === undefined) {
          return yield* new DataProductUsageExampleNotResolved({ exampleName: name });
        }
        return toAttributes(example);
      }

      // Sync
      const delta = changedFields({ ...example, description: example.description ?? "" }, desired);
      if (hasChanges(delta)) {
        yield* session.note(`Updating usage example ${name}...`);
        example = yield* galaxy.dataProductUsageExample.updateDataProductUsageExample({
          ...delta,
          dataProductId: news.dataProductId,
          usageExampleId: example.usageExampleId,
        });
      }
      return toAttributes(example);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* galaxy.dataProductUsageExample
        .deleteDataProductUsageExample({
          dataProductId: output.dataProductId,
          usageExampleId: output.usageExampleId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    // Examples live inside products; deleting a product removes them.
    list: () => Effect.succeed([]),
  });
