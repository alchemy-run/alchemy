/**
 * Shared scaffolding for Step Functions *service-scoped* operation bindings
 * (operations with no resource argument, e.g. `validateStateMachineDefinition`
 * and `testState`). NOT exported from the service `index.ts`.
 */
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";

/**
 * Build the impl effect for a zero-arity Step Functions binding: registers
 * the service-scoped IAM policy statement on the host (deploy time) and
 * returns the operation callable (runtime).
 */
export const makeSfnServiceBinding = <In, Out, Err, R>(options: {
  /** Fully-qualified binding name, e.g. `AWS.StepFunctions.TestState`. */
  readonly name: string;
  /** IAM actions the operation needs (service-scoped, `Resource: ["*"]`). */
  readonly actions: string[];
  /** The distilled operation (resolved once at layer construction). */
  readonly operation: Effect.Effect<
    (input: In) => Effect.Effect<Out, Err>,
    never,
    R
  >;
}) =>
  Effect.gen(function* () {
    const call = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.name}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: options.actions,
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(options.name)(function* (request: In) {
        return yield* call(request);
      });
    });
  });
