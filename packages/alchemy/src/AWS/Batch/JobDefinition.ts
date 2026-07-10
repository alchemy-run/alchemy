import * as batch from "@distilled.cloud/aws/batch";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import type { AccountID } from "../Environment.ts";
import type { RegionID } from "../Region.ts";

export type JobDefinitionName = string;
/** Revision-qualified job definition ARN (`.../job-definition/{name}:{revision}`). */
export type JobDefinitionArn =
  `arn:aws:batch:${RegionID}:${AccountID}:job-definition/${JobDefinitionName}:${number}`;

export interface JobDefinitionProps {
  /**
   * Name (family) of the job definition. If omitted, a unique name is
   * generated. Content changes register a new revision under the same name.
   */
  jobDefinitionName?: string;
  /**
   * Container image the job runs (e.g. `public.ecr.aws/docker/library/busybox:latest`).
   */
  image: string;
  /**
   * Command to run in the container. Overridable per-submission via
   * `containerOverrides.command`.
   */
  command?: string[];
  /**
   * Fargate vCPUs for the job. Must be a valid Fargate size (0.25, 0.5, 1,
   * 2, 4, 8, 16) compatible with `memory`.
   * @default 0.25
   */
  vcpus?: number;
  /**
   * Memory (MiB) for the job. Must be compatible with `vcpus` per the
   * Fargate size matrix.
   * @default 512
   */
  memory?: number;
  /**
   * Environment variables set in the job container.
   */
  environment?: Record<string, string>;
  /**
   * IAM role assumed by the job's application code.
   */
  jobRoleArn?: string;
  /**
   * Execution role used by ECS/Fargate to pull the image and write logs.
   * Required for Fargate jobs.
   */
  executionRoleArn: string;
  /**
   * Whether the Fargate task ENI gets a public IP. Required for image pulls
   * from public registries when running in public subnets.
   * @default "ENABLED"
   */
  assignPublicIp?: "ENABLED" | "DISABLED";
  /**
   * Default parameter substitutions for `Ref::` placeholders in `command`.
   */
  parameters?: Record<string, string>;
  /**
   * Number of times a failed job is retried (1-10).
   * @default 1
   */
  retryAttempts?: number;
  /**
   * Job execution timeout in seconds (minimum 60).
   */
  timeoutSeconds?: number;
  /**
   * Propagate job definition tags to the ECS task.
   * @default false
   */
  propagateTags?: boolean;
  /**
   * User-defined tags to apply to the job definition.
   */
  tags?: Record<string, string>;
}

export interface JobDefinition extends Resource<
  "AWS.Batch.JobDefinition",
  JobDefinitionProps,
  {
    jobDefinitionName: JobDefinitionName;
    jobDefinitionArn: JobDefinitionArn;
    revision: number;
    status: string;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS Batch job definition for Fargate container jobs. Job definitions are
 * immutable revisions — changing the container configuration registers a new
 * revision under the same name (like ECS task definitions); destroying the
 * resource deregisters every active revision.
 *
 * @resource
 * @section Creating Job Definitions
 * @example Busybox echo job
 * ```typescript
 * const jobDef = yield* Batch.JobDefinition("EchoJob", {
 *   image: "public.ecr.aws/docker/library/busybox:latest",
 *   command: ["echo", "hello from batch"],
 *   executionRoleArn: executionRole.roleArn,
 * });
 * ```
 *
 * @example Sized job with environment
 * ```typescript
 * const jobDef = yield* Batch.JobDefinition("EtlJob", {
 *   image: image.imageUri,
 *   vcpus: 1,
 *   memory: 2048,
 *   environment: { STAGE: "prod" },
 *   jobRoleArn: jobRole.roleArn,
 *   executionRoleArn: executionRole.roleArn,
 *   retryAttempts: 3,
 *   timeoutSeconds: 900,
 * });
 * ```
 */
export const JobDefinition = Resource<JobDefinition>("AWS.Batch.JobDefinition");

const observedTagsOf = (d: { tags?: { [key: string]: string | undefined } }) =>
  Object.fromEntries(
    Object.entries(d.tags ?? {}).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    ),
  );

const toAttributes = (
  d: batch.JobDefinition,
  tags: Record<string, string>,
) => ({
  jobDefinitionName: d.jobDefinitionName!,
  jobDefinitionArn: d.jobDefinitionArn as JobDefinitionArn,
  revision: d.revision ?? 1,
  status: d.status ?? "ACTIVE",
  tags,
});

/**
 * Normalized content fingerprint of a job definition — used to decide whether
 * a new revision must be registered. Only covers the aspects this resource
 * manages.
 */
const fingerprint = (input: {
  image?: string;
  command?: string[];
  vcpus?: string;
  memory?: string;
  environment?: Record<string, string>;
  jobRoleArn?: string;
  executionRoleArn?: string;
  assignPublicIp?: string;
  parameters?: Record<string, string>;
  retryAttempts?: number;
  timeoutSeconds?: number;
  propagateTags?: boolean;
}) =>
  JSON.stringify({
    image: input.image,
    command: input.command ?? [],
    vcpus: input.vcpus,
    memory: input.memory,
    environment: Object.entries(input.environment ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
    jobRoleArn: input.jobRoleArn,
    executionRoleArn: input.executionRoleArn,
    assignPublicIp: input.assignPublicIp ?? "ENABLED",
    parameters: Object.entries(input.parameters ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
    retryAttempts: input.retryAttempts ?? 1,
    timeoutSeconds: input.timeoutSeconds,
    propagateTags: input.propagateTags ?? false,
  });

const observedFingerprint = (d: batch.JobDefinition) => {
  const c = d.containerProperties ?? {};
  const req = (type: string) =>
    c.resourceRequirements?.find((r) => r.type === type)?.value;
  return fingerprint({
    image: c.image,
    command: [...(c.command ?? [])],
    vcpus: req("VCPU"),
    memory: req("MEMORY"),
    environment: Object.fromEntries(
      (c.environment ?? []).flatMap((kv) =>
        kv.name !== undefined ? [[kv.name, kv.value ?? ""]] : [],
      ),
    ),
    jobRoleArn: c.jobRoleArn,
    executionRoleArn: c.executionRoleArn,
    assignPublicIp: c.networkConfiguration?.assignPublicIp,
    parameters: Object.fromEntries(
      Object.entries(d.parameters ?? {}).flatMap(([k, v]) =>
        v !== undefined ? [[k, v]] : [],
      ),
    ),
    retryAttempts: d.retryStrategy?.attempts,
    timeoutSeconds: d.timeout?.attemptDurationSeconds,
    propagateTags: d.propagateTags,
  });
};

const desiredFingerprint = (news: JobDefinitionProps) =>
  fingerprint({
    image: news.image,
    command: news.command,
    vcpus: String(news.vcpus ?? 0.25),
    memory: String(news.memory ?? 512),
    environment: news.environment,
    jobRoleArn: news.jobRoleArn,
    executionRoleArn: news.executionRoleArn,
    assignPublicIp: news.assignPublicIp,
    parameters: news.parameters,
    retryAttempts: news.retryAttempts,
    timeoutSeconds: news.timeoutSeconds,
    propagateTags: news.propagateTags,
  });

export const JobDefinitionProvider = () =>
  Provider.effect(
    JobDefinition,
    Effect.gen(function* () {
      const toName = (id: string, props: { jobDefinitionName?: string } = {}) =>
        props.jobDefinitionName
          ? Effect.succeed(props.jobDefinitionName)
          : createPhysicalName({ id, maxLength: 128 });

      /** Every ACTIVE revision of the family, ascending by revision. */
      const activeRevisions = (name: string) =>
        batch.describeJobDefinitions
          .pages({ jobDefinitionName: name, status: "ACTIVE" })
          .pipe(
            Stream.runCollect,
            Effect.map((pages) =>
              Array.from(pages)
                .flatMap((page) => page.jobDefinitions ?? [])
                .sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0)),
            ),
          );

      const latestRevision = (name: string) =>
        activeRevisions(name).pipe(Effect.map((defs) => defs.at(-1)));

      return {
        stables: ["jobDefinitionName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.jobDefinitionName ?? (yield* toName(id, olds ?? {}));
          const latest = yield* latestRevision(name);
          if (!latest?.jobDefinitionArn) return undefined;
          return toAttributes(latest, observedTagsOf(latest));
        }),
        list: () =>
          Effect.gen(function* () {
            // Enumerate the latest ACTIVE revision of every family.
            const pages = yield* batch.describeJobDefinitions
              .pages({ status: "ACTIVE" })
              .pipe(Stream.runCollect);
            const latest = new Map<string, batch.JobDefinition>();
            for (const page of pages) {
              for (const d of page.jobDefinitions ?? []) {
                if (!d.jobDefinitionName || !d.jobDefinitionArn) continue;
                const prior = latest.get(d.jobDefinitionName);
                if (!prior || (prior.revision ?? 0) < (d.revision ?? 0)) {
                  latest.set(d.jobDefinitionName, d);
                }
              }
            }
            return Array.from(latest.values()).map((d) =>
              toAttributes(d, observedTagsOf(d)),
            );
          }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.jobDefinitionName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — the latest ACTIVE revision is the live state.
          const latest = yield* latestRevision(name);

          // Ensure/Sync — register a new revision only when managed content
          // differs (revisions are immutable; registration IS the update).
          if (
            !latest ||
            observedFingerprint(latest) !== desiredFingerprint(news)
          ) {
            const registered = yield* batch.registerJobDefinition({
              jobDefinitionName: name,
              type: "container",
              platformCapabilities: ["FARGATE"],
              containerProperties: {
                image: news.image,
                command: news.command,
                jobRoleArn: news.jobRoleArn,
                executionRoleArn: news.executionRoleArn,
                resourceRequirements: [
                  { type: "VCPU", value: String(news.vcpus ?? 0.25) },
                  { type: "MEMORY", value: String(news.memory ?? 512) },
                ],
                environment: Object.entries(news.environment ?? {}).map(
                  ([key, value]) => ({ name: key, value }),
                ),
                networkConfiguration: {
                  assignPublicIp: news.assignPublicIp ?? "ENABLED",
                },
              },
              parameters: news.parameters,
              retryStrategy:
                news.retryAttempts !== undefined
                  ? { attempts: news.retryAttempts }
                  : undefined,
              timeout:
                news.timeoutSeconds !== undefined
                  ? { attemptDurationSeconds: news.timeoutSeconds }
                  : undefined,
              propagateTags: news.propagateTags,
              tags: desiredTags,
            });
            yield* session.note(registered.jobDefinitionArn);
            return {
              jobDefinitionName: registered.jobDefinitionName,
              jobDefinitionArn: registered.jobDefinitionArn as JobDefinitionArn,
              revision: registered.revision,
              status: "ACTIVE",
              tags: desiredTags,
            };
          }

          // Content unchanged — sync tags in place on the revision ARN.
          const { upsert, removed } = diffTags(
            observedTagsOf(latest),
            desiredTags,
          );
          if (upsert.length > 0) {
            yield* batch.tagResource({
              resourceArn: latest.jobDefinitionArn!,
              tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* batch.untagResource({
              resourceArn: latest.jobDefinitionArn!,
              tagKeys: removed,
            });
          }

          yield* session.note(latest.jobDefinitionArn!);
          return toAttributes(latest, desiredTags);
        }),
        delete: Effect.fn(function* ({ output }) {
          // Deregister EVERY active revision of the family. Deregistration is
          // idempotent (succeeds when the revision is already gone).
          const revisions = yield* activeRevisions(output.jobDefinitionName);
          yield* Effect.forEach(
            revisions,
            (d) =>
              batch.deregisterJobDefinition({
                jobDefinition: `${d.jobDefinitionName}:${d.revision}`,
              }),
            { concurrency: 4 },
          );
        }),
      };
    }),
  );
