import * as glue from "@distilled.cloud/aws/glue";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeGlueCrawlerHttpBinding } from "./BindingHttp.ts";
import type { Crawler } from "./Crawler.ts";

/**
 * Runtime binding for `glue:StopCrawler`.
 *
 * Stops an in-progress crawl of the bound {@link Crawler}. Fails with the
 * typed `CrawlerNotRunningException` when idle and
 * `CrawlerStoppingException` when a stop is already underway. The crawler
 * name is injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.Glue.StopCrawlerHttp)`.
 * ### Running Crawlers
 * **Example:** Stop a Crawl
 * ```typescript
 * // init
 * const stopCrawler = yield* AWS.Glue.StopCrawler(crawler);
 *
 * // runtime — tolerate an idle or already-stopping crawler
 * yield* stopCrawler().pipe(
 *   Effect.catchTag(
 *     ["CrawlerNotRunningException", "CrawlerStoppingException"],
 *     () => Effect.void,
 *   ),
 * );
 * ```
 *
 * @binding
 */
export interface StopCrawler extends Binding.Service<
  StopCrawler,
  "AWS.Glue.StopCrawler",
  (
    crawler: Crawler,
  ) => Effect.Effect<() => Effect.Effect<glue.StopCrawlerResponse, glue.StopCrawlerError>>
> {}

export const StopCrawler = Binding.Service<StopCrawler>("AWS.Glue.StopCrawler");

export const StopCrawlerHttp = Layer.effect(
  StopCrawler,
  makeGlueCrawlerHttpBinding({
    tag: "AWS.Glue.StopCrawler",
    operation: glue.stopCrawler,
    actions: ["glue:StopCrawler"],
  }),
);
