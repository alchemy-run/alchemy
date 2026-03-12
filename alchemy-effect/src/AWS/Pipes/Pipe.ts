import * as pipes from "@distilled.cloud/aws/pipes";
import * as Effect from "effect/Effect";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasTags } from "../../Tags.ts";

export type PipeName = string;
export type PipeArn = string;

export interface PipeProps {
  /**
   * Pipe name. If omitted, Alchemy generates a deterministic physical name.
   */
  name?: string;
  /**
   * Optional description for the pipe.
   */
  description?: string;
  /**
   * Desired state, such as `RUNNING` or `STOPPED`.
   */
  desiredState?: string;
  /**
   * Source ARN.
   */
  source: Input<string>;
  /**
   * Source parameters for the selected source type.
   */
  sourceParameters?: Input<pipes.PipeSourceParameters>;
  /**
   * Optional enrichment target ARN.
   */
  enrichment?: Input<string>;
  /**
   * Enrichment parameters.
   */
  enrichmentParameters?: Input<pipes.PipeEnrichmentParameters>;
  /**
   * Target ARN.
   */
  target: Input<string>;
  /**
   * Target parameters for the selected target type.
   */
  targetParameters?: Input<pipes.PipeTargetParameters>;
  /**
   * IAM role ARN assumed by EventBridge Pipes.
   */
  roleArn: Input<string>;
  /**
   * Optional logging configuration.
   */
  logConfiguration?: Input<pipes.PipeLogConfigurationParameters>;
  /**
   * Optional KMS key identifier.
   */
  kmsKeyIdentifier?: Input<string>;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

/**
 * An EventBridge Pipe connecting a source to a target.
 *
 * `Pipe` is the canonical infrastructure resource for source-filter-enrich-target
 * transport flows. Higher-level helpers can synthesize the source parameters,
 * invoke role, and target configuration on top of this primitive.
 *
 * @section Creating Pipes
 * @example Queue To Lambda Pipe
 * ```typescript
 * const pipe = yield* Pipe("OrdersPipe", {
 *   source: queue.queueArn,
 *   sourceParameters: {
 *     SqsQueueParameters: {
 *       BatchSize: 10,
 *     },
 *   },
 *   target: fn.functionArn,
 *   roleArn: role.roleArn,
 * });
 * ```
 */
export interface Pipe extends Resource<
  "AWS.Pipes.Pipe",
  PipeProps,
  {
    pipeArn: PipeArn;
    pipeName: PipeName;
    desiredState: string | undefined;
    currentState: string | undefined;
    source: string | undefined;
    target: string | undefined;
  }
> {}

export const Pipe = Resource<Pipe>("AWS.Pipes.Pipe");

export const PipeProvider = () =>
  Pipe.provider.effect(
    Effect.gen(function* () {
      const toPipeName = (id: string, props: PipeProps) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({
              id,
              maxLength: 64,
            });

      return {
        stables: ["pipeArn", "pipeName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if ((yield* toPipeName(id, olds)) !== (yield* toPipeName(id, news))) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const pipeName = output?.pipeName ?? (yield* toPipeName(id, olds));
          const described = yield* pipes
            .describePipe({
              Name: pipeName,
            })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          if (!described?.Arn || !described.Name) {
            return undefined;
          }

          return {
            pipeArn: described.Arn,
            pipeName: described.Name,
            desiredState: described.DesiredState,
            currentState: described.CurrentState,
            source: described.Source,
            target: described.Target,
          };
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const pipeName = yield* toPipeName(id, news);
          const allTags = {
            ...(yield* createInternalTags(id)),
            ...(news.tags ?? {}),
          };

          const created = yield* pipes
            .createPipe({
              Name: pipeName,
              Description: news.description,
              DesiredState: news.desiredState,
              Source: news.source as string,
              SourceParameters: news.sourceParameters as
                | pipes.PipeSourceParameters
                | undefined,
              Enrichment: news.enrichment as string | undefined,
              EnrichmentParameters: news.enrichmentParameters as
                | pipes.PipeEnrichmentParameters
                | undefined,
              Target: news.target as string,
              TargetParameters: news.targetParameters as
                | pipes.PipeTargetParameters
                | undefined,
              RoleArn: news.roleArn as string,
              Tags: allTags,
              LogConfiguration: news.logConfiguration as
                | pipes.PipeLogConfigurationParameters
                | undefined,
              KmsKeyIdentifier: news.kmsKeyIdentifier as string | undefined,
            })
            .pipe(
              Effect.catchTag("ConflictException", () =>
                pipes.describePipe({ Name: pipeName }).pipe(
                  Effect.filterOrFail(
                    (existing) =>
                      hasTags(
                        allTags,
                        existing.Tags as
                          | Record<string, string | undefined>
                          | undefined,
                      ),
                    () =>
                      new Error(
                        `Pipe '${pipeName}' already exists and is not managed by alchemy`,
                      ),
                  ),
                  Effect.map((existing) => ({
                    Arn: existing.Arn,
                    Name: existing.Name,
                    DesiredState: existing.DesiredState,
                    CurrentState: existing.CurrentState,
                  })),
                ),
              ),
            );

          yield* session.note(created.Arn ?? pipeName);

          return {
            pipeArn: created.Arn ?? pipeName,
            pipeName: created.Name ?? pipeName,
            desiredState: created.DesiredState,
            currentState: created.CurrentState,
            source: news.source as string,
            target: news.target as string,
          };
        }),
        update: Effect.fn(function* ({ id, news, olds, output, session }) {
          const updated = yield* pipes.updatePipe({
            Name: output.pipeName,
            Description: news.description,
            DesiredState: news.desiredState,
            SourceParameters: news.sourceParameters as
              | pipes.UpdatePipeSourceParameters
              | undefined,
            Enrichment: news.enrichment as string | undefined,
            EnrichmentParameters: news.enrichmentParameters as
              | pipes.PipeEnrichmentParameters
              | undefined,
            Target: news.target as string,
            TargetParameters: news.targetParameters as
              | pipes.PipeTargetParameters
              | undefined,
            RoleArn: news.roleArn as string,
            LogConfiguration: news.logConfiguration as
              | pipes.PipeLogConfigurationParameters
              | undefined,
            KmsKeyIdentifier: news.kmsKeyIdentifier as string | undefined,
          });

          const oldTags = {
            ...(yield* createInternalTags(id)),
            ...(olds.tags ?? {}),
          };
          const newTags = {
            ...(yield* createInternalTags(id)),
            ...(news.tags ?? {}),
          };
          const { removed, upsert } = diffTags(oldTags, newTags);

          if (removed.length > 0) {
            yield* pipes.untagResource({
              resourceArn: output.pipeArn,
              tagKeys: removed,
            });
          }

          if (upsert.length > 0) {
            const tagsToAdd: Record<string, string> = {};
            for (const { Key, Value } of upsert) {
              tagsToAdd[Key] = Value;
            }

            yield* pipes.tagResource({
              resourceArn: output.pipeArn,
              tags: tagsToAdd,
            });
          }

          yield* session.note(output.pipeArn);

          return {
            pipeArn: updated.Arn ?? output.pipeArn,
            pipeName: updated.Name ?? output.pipeName,
            desiredState: updated.DesiredState ?? news.desiredState,
            currentState: updated.CurrentState ?? output.currentState,
            source: news.source as string,
            target: news.target as string,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* pipes
            .deletePipe({
              Name: output.pipeName,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),
      };
    }),
  );
