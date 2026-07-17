import * as config from "@distilled.cloud/aws/config-service";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

/**
 * Selects which resource types the configuration recorder records.
 */
export interface RecordingGroup {
  /**
   * Record all supported resource types.
   * @default true
   */
  allSupported?: boolean;
  /**
   * Also record supported global resource types (e.g. IAM). Only meaningful
   * with `allSupported`.
   * @default false
   */
  includeGlobalResourceTypes?: boolean;
  /**
   * An explicit list of resource types to record. Mutually exclusive with
   * `allSupported`.
   */
  resourceTypes?: string[];
}

export interface ConfigurationRecorderProps {
  /**
   * Name of the configuration recorder. AWS Config allows exactly one
   * customer-managed recorder per account per region; changing the name
   * replaces it.
   * @default ${app}-${stage}-${id}
   */
  recorderName?: string;
  /**
   * ARN of the IAM role AWS Config assumes to describe and record your
   * resources. Typically attaches the `AWS_ConfigRole` managed policy and
   * trusts `config.amazonaws.com`.
   */
  roleArn: string;
  /**
   * The resource types to record.
   * @default { allSupported: true }
   */
  recordingGroup?: RecordingGroup;
}

export interface ConfigurationRecorder extends Resource<
  "AWS.Config.ConfigurationRecorder",
  ConfigurationRecorderProps,
  {
    recorderName: string;
    roleArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Config configuration recorder — the account/region singleton that
 * captures configuration changes for your resources.
 *
 * AWS Config permits exactly one customer-managed recorder per region. Pair it
 * with a {@link DeliveryChannel} (Config requires a delivery channel before
 * recording can start).
 * @resource
 * @section Creating a Recorder
 * @example Record all supported resource types
 * ```typescript
 * import * as Config from "alchemy/AWS/Config";
 *
 * const recorder = yield* Config.ConfigurationRecorder("Recorder", {
 *   roleArn: role.roleArn,
 *   recordingGroup: { allSupported: true, includeGlobalResourceTypes: true },
 * });
 * ```
 */
export const ConfigurationRecorder = Resource<ConfigurationRecorder>(
  "AWS.Config.ConfigurationRecorder",
);

const toRecordingGroup = (
  group: RecordingGroup | undefined,
): config.RecordingGroup =>
  group?.resourceTypes
    ? { allSupported: false, resourceTypes: group.resourceTypes }
    : {
        allSupported: group?.allSupported ?? true,
        includeGlobalResourceTypes: group?.includeGlobalResourceTypes ?? false,
      };

export const ConfigurationRecorderProvider = () =>
  Provider.effect(
    ConfigurationRecorder,
    Effect.gen(function* () {
      const createRecorderName = Effect.fn(function* (
        id: string,
        props: { recorderName?: string | undefined },
      ) {
        return (
          props.recorderName ??
          (yield* createPhysicalName({ id, maxLength: 256 }))
        );
      });

      const observeRecorder = (name: string) =>
        config
          .describeConfigurationRecorders({
            ConfigurationRecorderNames: [name],
          })
          .pipe(
            Effect.map((r) => r.ConfigurationRecorders?.[0]),
            Effect.catchTag("NoSuchConfigurationRecorderException", () =>
              Effect.succeed(undefined),
            ),
          );

      return ConfigurationRecorder.Provider.of({
        stables: ["recorderName"],
        // A recorder is an account/region singleton; enumerate the (at most
        // one) customer-managed recorder present in the region.
        list: () =>
          config.describeConfigurationRecorders({}).pipe(
            Effect.map((r) =>
              (r.ConfigurationRecorders ?? []).flatMap((rec) =>
                rec.name
                  ? [{ recorderName: rec.name, roleArn: rec.roleARN ?? "" }]
                  : [],
              ),
            ),
            Effect.catchTag("NoSuchConfigurationRecorderException", () =>
              Effect.succeed([]),
            ),
          ),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.recorderName ?? (yield* createRecorderName(id, olds ?? {}));
          const rec = yield* observeRecorder(name);
          if (!rec) return undefined;
          return { recorderName: name, roleArn: rec.roleARN ?? "" };
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createRecorderName(id, olds ?? {});
          const newName = yield* createRecorderName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name =
            output?.recorderName ?? (yield* createRecorderName(id, news));
          // putConfigurationRecorder is an idempotent upsert — one flow covers
          // create, update, and adoption. A freshly-created IAM role is not
          // immediately assumable, surfacing as InvalidRoleException — an
          // eventual-consistency race, so retry on a bounded schedule.
          yield* config
            .putConfigurationRecorder({
              ConfigurationRecorder: {
                name,
                roleARN: news.roleArn,
                recordingGroup: toRecordingGroup(news.recordingGroup),
              },
            })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "InvalidRoleException",
                schedule: Schedule.max([
                  Schedule.fixed(2000),
                  Schedule.recurs(15),
                ]),
              }),
            );
          yield* session.note(name);
          return { recorderName: name, roleArn: news.roleArn };
        }),
        delete: Effect.fn(function* ({ output }) {
          // Stop first so a running recorder can be removed; then delete. Both
          // are idempotent against a missing recorder.
          yield* config
            .stopConfigurationRecorder({
              ConfigurationRecorderName: output.recorderName,
            })
            .pipe(
              Effect.catchTag(
                "NoSuchConfigurationRecorderException",
                () => Effect.void,
              ),
            );
          yield* config
            .deleteConfigurationRecorder({
              ConfigurationRecorderName: output.recorderName,
            })
            .pipe(
              Effect.catchTag(
                "NoSuchConfigurationRecorderException",
                () => Effect.void,
              ),
            );
        }),
      });
    }),
  );
