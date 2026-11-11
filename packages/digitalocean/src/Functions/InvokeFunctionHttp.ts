import * as Fn from "@distilled.cloud/digitalocean/Functions";
import * as Binding from "alchemy/Binding";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { AccessKey } from "./AccessKey.ts";
import type { Action } from "./Action.ts";
import {
  FunctionBindingNotConfigured,
  FunctionInvocationFailed,
  InvokeFunction,
  type InvokeFunctionClient,
} from "./InvokeFunction.ts";

const envKey = (fn: Action, field: string) =>
  `DO_FUNCTION_${fn.LogicalId}_${field}`.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_");

/**
 * `InvokeFunction` over the namespace's OpenWhisk API, with a
 * `Functions.AccessKey` minted for the host.
 *
 * @layer
 * @product Functions
 * @provides DigitalOcean.Functions.InvokeFunction
 */
export const InvokeFunctionHttp = Layer.effect(
  InvokeFunction,
  Effect.gen(function* () {
    // The key resource is resolved once, when the layer is built; a host
    // bundle never declares it.
    const FunctionsKey = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* AccessKey;

    return Effect.fn(function* (fn: Action) {
      if (FunctionsKey !== undefined) {
        const host = yield* Binding.Host;
        const runtime = yield* CurrentRuntimeContext;
        if (host !== undefined && runtime !== undefined) {
          const key = yield* FunctionsKey(`${host.LogicalId}${fn.LogicalId}Key`, {
            namespaceId: fn.namespaceId,
          });
          yield* runtime.set(envKey(fn, "api_host"), fn.apiHost);
          yield* runtime.set(envKey(fn, "namespace"), fn.namespaceId);
          yield* runtime.set(envKey(fn, "name"), fn.name);
          yield* runtime.set(envKey(fn, "key_id"), key.keyId);
          yield* runtime.set(envKey(fn, "secret"), key.secret);
        }
      }

      // Read in the construction phase, where the host's runtime context is
      // present; request handlers close over the values.
      const runtime = globalThis.__ALCHEMY_RUNTIME__ ? yield* CurrentRuntimeContext : undefined;
      const read = Effect.fn(function* (field: string) {
        return runtime === undefined
          ? undefined
          : yield* runtime.get<string | Redacted.Redacted<string>>(envKey(fn, field));
      });
      const plain = (value: string | Redacted.Redacted<string> | undefined) =>
        value === undefined || typeof value === "string" ? value : Redacted.value(value);
      const apiHost = plain(yield* read("api_host"));
      const namespace = plain(yield* read("namespace"));
      const name = plain(yield* read("name"));
      const keyId = plain(yield* read("key_id"));
      const secret = yield* read("secret");

      const invoke = Effect.fn(`DigitalOcean.Functions.InvokeFunction(${fn.LogicalId})`)(function* (
        parameters?: Record<string, unknown>,
      ) {
        if (!apiHost || !namespace || !name || !keyId || secret === undefined) {
          return yield* new FunctionBindingNotConfigured({ function: fn.LogicalId });
        }
        const activation = yield* Fn.invokeAction({
          namespace,
          action_name: name,
          blocking: true,
          body: parameters,
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Fn.fromFunctionsKey({
                apiHost,
                user: keyId,
                secret: typeof secret === "string" ? Redacted.make(secret) : secret,
              }),
              FetchHttpClient.layer,
            ),
          ),
        );
        if (activation.response?.success !== true) {
          return yield* new FunctionInvocationFailed({
            function: name,
            activationId: activation.activationId,
            status: activation.response?.status,
            result: activation.response?.result,
          });
        }
        return activation.response.result;
      });
      return invoke as InvokeFunctionClient;
    });
  }),
);
