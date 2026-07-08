import * as Cloudflare from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class SandboxContainer extends Cloudflare.Container<
  SandboxContainer,
  {}
>()("SandboxContainer") {}

export const SandboxLive = /* @__PURE__ */ SandboxContainer.make(
  Stack.useSync((stack) => ({
    main: import.meta.url,
    instanceType: stack.stage === "prod" ? "standard-1" : "dev",
    observability: {
      logs: {
        enabled: true,
      },
    },
  })),
  Effect.gen(function* () {
    return SandboxContainer.of({
      fetch: Effect.succeed(
        HttpServerResponse.text("Hello from Sandbox container!"),
      ),
    });
  }),
);

export default SandboxLive;
