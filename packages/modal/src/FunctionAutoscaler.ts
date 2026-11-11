import * as functions from "@distilled.cloud/modal/functions";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { type EnvironmentInput, envNameOf, environmentOf, seconds } from "./internal.ts";
import { declarable } from "./internal/Declared.ts";
import type { Providers } from "./Providers.ts";

export class FunctionAutoscalerUnexpectedResponse extends Data.TaggedError(
  "Modal.FunctionAutoscalerUnexpectedResponse",
)<{
  readonly message: string;
}> {}

export interface FunctionAutoscalerProps {
  /** Name of the deployed App that defines the function. */
  app: string;
  /**
   * The function's name in the App (`"f"` for `@app.function() def f`, or
   * `"Model.*"` for a class). Changing it, the app or the environment
   * replaces this resource.
   */
  function: string;
  /**
   * Environment the App is deployed in.
   * @default the workspace's default environment
   */
  environment?: EnvironmentInput;
  /** Containers kept running even with no inputs (`min_containers`). */
  minContainers?: number;
  /** Most containers the function runs at once (`max_containers`). */
  maxContainers?: number;
  /** Extra idle containers kept ready while the function is busy (`buffer_containers`). */
  bufferContainers?: number;
  /** How long an idle container stays up before scaling down (`scaledown_window`). */
  scaledownWindow?: number | string;
  /** Sustained demand needed before scaling up (`scaleup_window`). */
  scaleupWindow?: number | string;
  /** Inputs each container handles at once before more are added. */
  targetConcurrency?: number;
}

/** The autoscaler settings Modal stores for a function. */
export interface AutoscalerSettingsState {
  minContainers?: number;
  maxContainers?: number;
  bufferContainers?: number;
  scaledownWindow?: number;
  scaleupWindow?: number;
  targetConcurrency?: number;
}

export interface FunctionAutoscalerAttributes {
  /** Function ID (`fu-…`). */
  functionId: string;
  /** The settings in effect after the last deploy. */
  settings: AutoscalerSettingsState;
  /** The settings found before the first deploy, restored on destroy. */
  original: AutoscalerSettingsState;
}

/**
 * Autoscaling settings for a Modal Function deployed with Modal's Python
 * client (`modal deploy`): warm containers, a container cap, buffer
 * containers and scale-down timing, changed without redeploying the app.
 *
 * For a `Modal.Function` or `Modal.Server` of the Stack, set these on the
 * resource itself. This resource adjusts a function deployed outside the
 * Stack, and restores
 * the settings it found when destroyed. Modal resets overrides like these
 * when the app is redeployed, so redeploying the app and then this stack
 * applies them again.
 *
 * ### Keeping containers warm
 * **Example:** Two warm containers during business hours
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 *
 * export const Warm = Modal.FunctionAutoscaler("Warm", {
 *   app: "inference",
 *   function: "Model.*",
 *   minContainers: 2,
 *   bufferContainers: 1,
 *   scaledownWindow: "5 minutes",
 * });
 * ```
 *
 * @resource
 * @product Function
 */
export const FunctionAutoscaler = declarable<FunctionAutoscaler>()(
  Resource<FunctionAutoscaler>("Modal.FunctionAutoscaler"),
);

export type FunctionAutoscaler = Resource<
  "Modal.FunctionAutoscaler",
  FunctionAutoscalerProps,
  FunctionAutoscalerAttributes,
  never,
  Providers
>;

const fromWire = (s: functions.AutoscalerSettings | undefined): AutoscalerSettingsState => ({
  minContainers: s?.minContainers,
  maxContainers: s?.maxContainers,
  bufferContainers: s?.bufferContainers,
  scaledownWindow: s?.scaledownWindow,
  scaleupWindow: s?.scaleupWindow,
  targetConcurrency: s?.targetConcurrency,
});

const toWire = (s: AutoscalerSettingsState): functions.AutoscalerSettings => ({
  minContainers: s.minContainers,
  maxContainers: s.maxContainers,
  bufferContainers: s.bufferContainers,
  scaledownWindow: s.scaledownWindow,
  scaleupWindow: s.scaleupWindow,
  targetConcurrency: s.targetConcurrency,
});

const desiredOf = (news: FunctionAutoscalerProps): AutoscalerSettingsState => ({
  minContainers: news.minContainers,
  maxContainers: news.maxContainers,
  bufferContainers: news.bufferContainers,
  scaledownWindow: seconds(news.scaledownWindow),
  scaleupWindow: seconds(news.scaleupWindow),
  targetConcurrency: news.targetConcurrency,
});

export const FunctionAutoscalerProvider = () =>
  Provider.effect(
    FunctionAutoscaler,
    Effect.gen(function* () {
      const lookup = Effect.fn(function* (news: FunctionAutoscalerProps) {
        const found = yield* functions
          .getFunction({
            appName: news.app,
            objectTag: news.function,
            environmentName: environmentOf(envNameOf(news.environment)),
          })
          .pipe(Effect.catchTag("FunctionNotFound", () => Effect.undefined));
        return found?.functionId;
      });

      const current = Effect.fn(function* (functionId: string) {
        const { autoscalerConfiguration } = yield* functions.functionGetSchedulingParams({
          functionId,
        });
        return autoscalerConfiguration;
      });

      return {
        stables: ["functionId", "original"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            news.app !== olds?.app ||
            news.function !== olds?.function ||
            envNameOf(news.environment) !== envNameOf(olds?.environment)
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ olds, output }) {
          if (output === undefined || olds === undefined) return undefined;
          const config = yield* current(output.functionId).pipe(
            Effect.catchTag("FunctionNotFound", () => Effect.undefined),
          );
          if (!config) return undefined;
          return { ...output, settings: fromWire(config.settings) };
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          // Observe: the function (by name; its id changes on redeploy) and
          // the settings in effect.
          const functionId = yield* lookup(news);
          if (!functionId) {
            return yield* new FunctionAutoscalerUnexpectedResponse({
              message: `Modal function ${news.app}.${news.function} isn't deployed${envNameOf(news.environment) ? ` in ${envNameOf(news.environment)}` : ""}`,
            });
          }
          const config = yield* current(functionId);
          const observed = fromWire(config?.settings);
          const original = output?.original ?? fromWire(config?.staticSettings ?? config?.settings);
          // Sync only the settings that differ.
          const desired = desiredOf(news);
          const changed = (Object.keys(desired) as (keyof AutoscalerSettingsState)[]).some(
            (key) => desired[key] !== undefined && desired[key] !== observed[key],
          );
          if (!changed) return { functionId, settings: observed, original };
          yield* session.note(`Updating autoscaler of ${news.app}.${news.function}...`);
          const { currentSettings } = yield* functions.functionUpdateSchedulingParams({
            functionId,
            settings: toWire(desired),
          });
          return { functionId, settings: fromWire(currentSettings), original };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* functions
            .functionUpdateSchedulingParams({
              functionId: output.functionId,
              settings: toWire(output.original),
            })
            .pipe(Effect.catchTag("FunctionNotFound", () => Effect.void));
        }),
      };
    }),
  );
