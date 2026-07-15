import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { DataAutomationProject } from "./DataAutomationProject.ts";

/**
 * Shared scaffolding for Bedrock Data Automation HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two
 * builders below. Everything except the operation and the IAM action list is
 * boilerplate.
 */

/**
 * Build the impl Effect for a project-scoped runtime operation (the sync and
 * async invoke APIs). The runtime callable injects the bound
 * {@link DataAutomationProject}'s ARN + stage as `dataAutomationConfiguration`
 * and the deploy-time half grants `actions` on the project ARN plus the
 * account's data automation profiles in every region — cross-region
 * inference profiles (e.g. `us.data-automation-v1`) fan requests out to
 * sibling regions, so the profile grant cannot be scoped to one region.
 */
export const makeBdaProjectHttpBinding = <
  I extends {
    dataAutomationConfiguration?: {
      dataAutomationProjectArn: string;
      stage?: string;
    };
  },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.BedrockDataAutomation.InvokeDataAutomationAsync`. */
  tag: string;
  /** The distilled operation; `dataAutomationConfiguration` is injected from the project. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the project ARN + the account's profiles. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (project: DataAutomationProject) {
      const projectArn = yield* project.projectArn;
      const projectStage = yield* project.projectStage;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${project}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [
                  Output.interpolate`${project.projectArn}`,
                  // Cross-region inference profiles live in every region of
                  // the geography (us./eu./apac.), so the profile resource
                  // cannot be pinned to the deploy region.
                  "arn:aws:bedrock:*:*:data-automation-profile/*",
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${project.LogicalId})`)(function* (
        request: Omit<I, "dataAutomationConfiguration">,
      ) {
        return yield* op({
          ...request,
          dataAutomationConfiguration: {
            dataAutomationProjectArn: yield* projectArn,
            stage: yield* projectStage,
          },
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level runtime operation (job status
 * polling). The deploy-time half grants `actions` on `*` — invocation ARNs
 * (`…:data-automation-invocation/{id}`) are minted at runtime and unknowable
 * at deploy time.
 */
export const makeBdaAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.BedrockDataAutomation.GetDataAutomationStatus`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(options.tag)(function* (request: I) {
        return yield* op(request);
      });
    });
  });
