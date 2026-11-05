import * as opensearch from "@distilled.cloud/aws/opensearch";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOpenSearchHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for the `DescribeDomainAutoTunes` operation (IAM action
 * `es:DescribeDomainAutoTunes`).
 *
 * Lists the Auto-Tune optimizations scheduled for a domain — e.g. to surface upcoming JVM heap or queue tuning actions to operators. Provide the implementation with
 * `Effect.provide(AWS.OpenSearch.DescribeDomainAutoTunesHttp)`.
 * ### Auto-Tune and Scheduled Actions
 * **Example:** List Scheduled Auto-Tune Optimizations
 * ```typescript
 * const describeDomainAutoTunes = yield* OpenSearch.DescribeDomainAutoTunes();
 *
 * const result = yield* describeDomainAutoTunes({ DomainName: name });
 * // result.AutoTunes → scheduled optimizations
 * ```
 *
 * @binding
 */
export interface DescribeDomainAutoTunes extends Binding.Service<
  DescribeDomainAutoTunes,
  "AWS.OpenSearch.DescribeDomainAutoTunes",
  () => Effect.Effect<
    (
      request: opensearch.DescribeDomainAutoTunesRequest,
    ) => Effect.Effect<
      opensearch.DescribeDomainAutoTunesResponse,
      opensearch.DescribeDomainAutoTunesError
    >
  >
> {}
export const DescribeDomainAutoTunes = Binding.Service<DescribeDomainAutoTunes>(
  "AWS.OpenSearch.DescribeDomainAutoTunes",
);

export const DescribeDomainAutoTunesHttp = Layer.effect(
  DescribeDomainAutoTunes,
  makeOpenSearchHttpBinding({
    tag: "AWS.OpenSearch.DescribeDomainAutoTunes",
    operation: opensearch.describeDomainAutoTunes,
    actions: ["es:DescribeDomainAutoTunes"],
  }),
);
