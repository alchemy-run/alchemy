import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AlchemyContext } from "../AlchemyContext.ts";
import { AuthProviders } from "../Auth/AuthProvider.ts";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive, withProfileOverride } from "../Auth/Profile.ts";
import { Stack } from "../Stack.ts";
import { Stage } from "../Stage.ts";
import { loadConfigProvider } from "../Util/ConfigProvider.ts";

export interface RpcProcessContext {
  alchemyContext: AlchemyContext["Service"];
  profile: string | undefined;
  envFile: string | undefined;
  stack: {
    name: string;
    stage: string;
  };
}

export const CONTEXT_ENV_KEY = "ALCHEMY_RPC_PROCESS_CONTEXT" as const;

export const fromEnv = () => {
  try {
    const context = JSON.parse(
      process.env[CONTEXT_ENV_KEY]!,
    ) as RpcProcessContext;
    return layer(context);
  } catch (cause) {
    throw new Error(`Failed to parse ${CONTEXT_ENV_KEY} environment variable`, {
      cause,
    });
  }
};

export const layer = (context: RpcProcessContext) =>
  Layer.mergeAll(
    ProfileLive,
    CredentialsStoreLive,
    Layer.succeed(AuthProviders, {}),
    ConfigProvider.layer(
      loadConfigProvider(Option.fromUndefinedOr(context.envFile)).pipe(
        Effect.map((base) => withProfileOverride(base, context.profile)),
      ),
    ),
    Layer.succeed(AlchemyContext, context.alchemyContext),
    Layer.succeed(Stack, {
      name: context.stack.name,
      stage: context.stack.stage,
      resources: {},
      bindings: {},
      actions: {},
    }),
    Layer.succeed(Stage, context.stack.stage),
  );
