import * as emrc from "@distilled.cloud/aws/emr-containers";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface JobTemplateSparkSubmitJobDriver {
  /**
   * The entry point of the Spark application — an S3 URI to a jar or Python
   * script (e.g. `s3://my-bucket/scripts/etl.py`).
   */
  entryPoint: string;
  /**
   * Arguments passed to the entry point.
   */
  entryPointArguments?: string[];
  /**
   * `spark-submit` parameters (e.g. `--conf spark.executor.instances=2`).
   */
  sparkSubmitParameters?: string;
}

export interface JobTemplateSparkSqlJobDriver {
  /**
   * The S3 URI of the SQL file to execute.
   */
  entryPoint?: string;
  /**
   * Spark SQL parameters.
   */
  sparkSqlParameters?: string;
}

export interface JobTemplateJobDriver {
  /**
   * The Spark submit job driver.
   */
  sparkSubmitJobDriver?: JobTemplateSparkSubmitJobDriver;
  /**
   * The Spark SQL job driver.
   */
  sparkSqlJobDriver?: JobTemplateSparkSqlJobDriver;
}

export interface JobTemplateConfiguration {
  /**
   * The classification of the configuration (e.g. `spark-defaults`).
   */
  classification: string;
  /**
   * Configuration properties for the classification.
   */
  properties?: Record<string, string>;
  /**
   * Nested configurations.
   */
  configurations?: JobTemplateConfiguration[];
}

export interface JobTemplateMonitoringConfiguration {
  /**
   * Whether the persistent application UI (Spark history server) is enabled.
   */
  persistentAppUI?: "ENABLED" | "DISABLED" | (string & {});
  /**
   * CloudWatch log delivery for the job's containers.
   */
  cloudWatchMonitoringConfiguration?: {
    /** The CloudWatch log group to deliver logs to. */
    logGroupName?: string;
    /** A prefix for the log stream names. */
    logStreamNamePrefix?: string;
  };
  /**
   * S3 log delivery for the job's containers.
   */
  s3MonitoringConfiguration?: {
    /** The S3 URI to deliver logs to. */
    logUri?: string;
  };
}

export interface JobTemplateConfigurationOverrides {
  /**
   * Application configurations (Spark/Hadoop classification properties).
   */
  applicationConfiguration?: JobTemplateConfiguration[];
  /**
   * Monitoring (log delivery) configuration.
   */
  monitoringConfiguration?: JobTemplateMonitoringConfiguration;
}

export interface JobTemplateParameterConfiguration {
  /**
   * The data type of the template parameter.
   * @default "STRING"
   */
  type?: "NUMBER" | "STRING" | (string & {});
  /**
   * The default value used when `StartJobRun` omits the parameter.
   */
  defaultValue?: string;
}

export interface JobTemplateDataProps {
  /**
   * The IAM execution role ARN the job runs as. May reference template
   * parameters (e.g. `${ExecutionRoleArn}`).
   */
  executionRoleArn: string;
  /**
   * The EMR release label (e.g. `emr-7.5.0-latest`).
   */
  releaseLabel: string;
  /**
   * Configuration overrides applied to jobs started from the template.
   */
  configurationOverrides?: JobTemplateConfigurationOverrides;
  /**
   * The job driver (Spark submit or Spark SQL) for jobs started from the
   * template.
   */
  jobDriver: JobTemplateJobDriver;
  /**
   * Declares the `${placeholders}` used in the template and their types /
   * default values.
   */
  parameterConfiguration?: Record<string, JobTemplateParameterConfiguration>;
  /**
   * Tags applied to the *job runs* started from this template (distinct from
   * the template's own `tags`).
   */
  jobTags?: Record<string, string>;
}

export interface JobTemplateProps {
  /**
   * Name of the job template (1-64 characters). Changing the name replaces
   * the job template.
   * @default a generated physical name
   */
  jobTemplateName?: string;
  /**
   * The StartJobRun values the template stores. Job templates are immutable —
   * any change replaces the template.
   */
  jobTemplateData: JobTemplateDataProps;
  /**
   * The KMS key ARN used to encrypt the template. Changing it replaces the
   * job template.
   */
  kmsKeyArn?: string;
  /**
   * Tags to apply to the job template. Merged with the internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface JobTemplate extends Resource<
  "AWS.EMRContainers.JobTemplate",
  JobTemplateProps,
  {
    /** The ID of the job template. */
    jobTemplateId: string;
    /** The name of the job template. */
    jobTemplateName: string;
    /** The ARN of the job template. */
    jobTemplateArn: string;
  },
  {},
  Providers
> {}

/**
 * An Amazon EMR on EKS job template — a stored set of `StartJobRun` values
 * (execution role, release label, job driver, configuration) that can be
 * referenced by ID when starting job runs, optionally with `${placeholder}`
 * parameters filled in per run.
 *
 * Job templates are account-level and immutable: everything except tags
 * replaces the template. They pair with the
 * {@link StartJobRun | AWS.EMRContainers.StartJobRun} binding — a Lambda can
 * start a templated Spark job with just the template ID and parameter values.
 *
 * @resource
 * @section Creating Job Templates
 * @example A Spark Job Template
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const template = yield* AWS.EMRContainers.JobTemplate("EtlTemplate", {
 *   jobTemplateData: {
 *     executionRoleArn: jobRole.roleArn,
 *     releaseLabel: "emr-7.5.0-latest",
 *     jobDriver: {
 *       sparkSubmitJobDriver: {
 *         entryPoint: "s3://my-bucket/scripts/etl.py",
 *         sparkSubmitParameters: "--conf spark.executor.instances=2",
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * @example Parameterized Template
 * ```typescript
 * const template = yield* AWS.EMRContainers.JobTemplate("Parameterized", {
 *   jobTemplateData: {
 *     executionRoleArn: jobRole.roleArn,
 *     releaseLabel: "emr-7.5.0-latest",
 *     jobDriver: {
 *       sparkSubmitJobDriver: { entryPoint: "${EntryPoint}" },
 *     },
 *     parameterConfiguration: {
 *       EntryPoint: { type: "STRING" },
 *     },
 *   },
 * });
 * // StartJobRun with jobTemplateId + jobTemplateParameters: { EntryPoint: "s3://..." }
 * ```
 */
export const JobTemplate = Resource<JobTemplate>(
  "AWS.EMRContainers.JobTemplate",
);

/** Convert declared props to the distilled wire shape. */
const toJobTemplateData = (
  data: JobTemplateDataProps,
): emrc.JobTemplateData => ({
  executionRoleArn: data.executionRoleArn,
  releaseLabel: data.releaseLabel,
  configurationOverrides: data.configurationOverrides,
  jobDriver: data.jobDriver,
  parameterConfiguration: data.parameterConfiguration,
  jobTags: data.jobTags,
});

export const JobTemplateProvider = () =>
  Provider.effect(
    JobTemplate,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { jobTemplateName?: string | undefined },
      ) {
        return (
          props.jobTemplateName ??
          (yield* createPhysicalName({ id, maxLength: 64 }))
        );
      });

      const toAttributes = (jt: emrc.JobTemplate) => ({
        jobTemplateId: jt.id!,
        jobTemplateName: jt.name!,
        jobTemplateArn: jt.arn!,
      });

      const observeById = Effect.fn(function* (id: string) {
        return yield* emrc.describeJobTemplate({ id }).pipe(
          Effect.map((response) => response.jobTemplate),
          Effect.catchTag(
            ["ResourceNotFoundException", "ValidationException"],
            // a malformed/unknown id is "not present", same as not-found
            () => Effect.succeed(undefined),
          ),
        );
      });

      const observeByName = Effect.fn(function* (name: string) {
        return yield* emrc.listJobTemplates.items({}).pipe(
          Stream.filter((jt) => jt.name === name),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
        );
      });

      const observe = Effect.fn(function* (
        id: string | undefined,
        name: string,
      ) {
        const byId = id !== undefined ? yield* observeById(id) : undefined;
        return byId ?? (yield* observeByName(name));
      });

      const syncTags = Effect.fn(function* (
        jt: emrc.JobTemplate,
        desired: Record<string, string>,
      ) {
        // Diff against OBSERVED cloud tags (adoption may bring foreign tags).
        const observed = Object.fromEntries(
          Object.entries(jt.tags ?? {}).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        );
        const { upsert, removed } = diffTags(observed, desired);
        if (upsert.length > 0) {
          yield* emrc.tagResource({
            resourceArn: jt.arn!,
            tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
          });
        }
        if (removed.length > 0) {
          yield* emrc.untagResource({
            resourceArn: jt.arn!,
            tagKeys: removed,
          });
        }
      });

      return JobTemplate.Provider.of({
        stables: ["jobTemplateId", "jobTemplateName", "jobTemplateArn"],

        list: () =>
          Effect.gen(function* () {
            const pages = yield* emrc.listJobTemplates
              .pages({})
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.templates ?? [])
              .filter(
                (jt) =>
                  jt.id !== undefined &&
                  jt.name !== undefined &&
                  jt.arn !== undefined,
              )
              .map(toAttributes);
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.jobTemplateName ?? (yield* createName(id, olds ?? {}));
          const jt = yield* observe(output?.jobTemplateId, name);
          if (jt?.id === undefined || jt.arn === undefined) {
            return undefined;
          }
          const attrs = toAttributes(jt);
          return (yield* hasAlchemyTags(id, jt.tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (
            oldName !== newName ||
            JSON.stringify(toJobTemplateData(olds.jobTemplateData)) !==
              JSON.stringify(toJobTemplateData(news.jobTemplateData)) ||
            olds.kmsKeyArn !== news.kmsKeyArn
          ) {
            // everything except tags is immutable
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({
          id,
          news,
          output,
          session,
          instanceId,
        }) {
          const name = output?.jobTemplateName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE — cloud state is authoritative; output is an id cache
          let jt = yield* observe(output?.jobTemplateId, name);

          // 2. ENSURE — create if missing (synchronous, available immediately)
          if (jt === undefined) {
            const created = yield* emrc.createJobTemplate({
              // deterministic per instance: a retried create after a crashed
              // reconcile never double-provisions
              clientToken:
                instanceId.replaceAll(/[^a-zA-Z0-9]/g, "").slice(0, 64) ||
                "alchemy",
              name,
              jobTemplateData: toJobTemplateData(news.jobTemplateData),
              kmsKeyArn: news.kmsKeyArn,
              tags: desiredTags,
            });
            jt =
              created.id !== undefined
                ? yield* emrc
                    .describeJobTemplate({ id: created.id })
                    .pipe(Effect.map((r) => r.jobTemplate))
                : yield* observeByName(name);
            if (jt?.id === undefined) {
              return yield* Effect.fail(
                new emrc.ResourceNotFoundException({
                  message: `job template ${name} not visible after create`,
                }),
              );
            }
          }

          // 3. SYNC TAGS — the only mutable aspect; diff observed vs desired
          yield* syncTags(jt, desiredTags);

          yield* session.note(jt.id!);
          return toAttributes(jt);
        }),

        delete: Effect.fn(function* ({ output }) {
          // deleteJobTemplate's typed union has no not-found tag — the API
          // reports missing/already-deleted ids as validation errors, which
          // makes the swallow below the idempotency guarantee.
          yield* emrc
            .deleteJobTemplate({ id: output.jobTemplateId })
            .pipe(Effect.catchTag("ValidationException", () => Effect.void));
        }),
      });
    }),
  );
