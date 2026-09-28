import { Platform, type Main, type PlatformProps } from "@/Platform.ts";
import * as Provider from "@/Provider.ts";
import type { Resource } from "@/Resource";
import {
  createHostRuntimeContext,
  type HostRuntimeContext,
  type ServerHost,
} from "@/Server/Process.ts";
import { unpackEnvValue } from "@/RuntimeContext.ts";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// #1831: values an Init body captures (`yield* Config.x(...)`) reach the
// provider only through `props.env`. This provider's diff returns an explicit
// `noop` without looking at `env`, as the Cloudflare Worker's did, so only the
// engine's own comparison can plan the update.
interface HostProps extends PlatformProps {
  main?: string;
  env?: Record<string, unknown>;
}

interface Host extends Resource<"Test.CapturedConfigHost", HostProps, {}> {}

const Host: Platform<
  Host,
  ServerHost,
  Main<ServerHost>,
  HostRuntimeContext
> = Platform("Test.CapturedConfigHost", {
  createRuntimeContext: createHostRuntimeContext("Test.CapturedConfigHost"),
});

const reconciled: unknown[] = [];

const hostProvider = () =>
  Provider.succeed(Host, {
    list: () => Effect.succeed([]),
    diff: () => Effect.succeed({ action: "noop" as const }),
    reconcile: Effect.fn(function* ({ news }) {
      const value = unpackEnvValue(news.env?.CAPTURED_MODE as string);
      reconciled.push(
        Redacted.isRedacted(value) ? Redacted.value(value) : value,
      );
      return {};
    }),
    delete: Effect.fn(function* () {}),
  });

const { test } = Test.make({
  providers: hostProvider(),
  state: inMemoryState(),
});

const actionOf = (plan: any, logicalId: string) =>
  (Object.values(plan.resources) as any[]).find(
    (node: any) => node.resource.LogicalId === logicalId,
  )?.action;

// Serve `mode` to Init's `Config` reads over the ambient provider.
const program = (mode: string) =>
  Effect.gen(function* () {
    const ambient = yield* ConfigProvider.ConfigProvider;
    return yield* Host(
      "Host",
      { main: "index.ts" },
      Effect.gen(function* () {
        const value = yield* Config.String("CAPTURED_MODE");
        return { fetch: Effect.succeed(HttpServerResponse.text(value)) };
      }),
    ).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.orElse(
          ConfigProvider.fromUnknown({ CAPTURED_MODE: mode }),
          ambient,
        ),
      ),
    );
  });

describe("Platform Init-captured config", { tags: ["unit", "local"] }, () => {
  test.provider(
    "a changed value plans an update even when the provider diff is noop",
    (stack) =>
      Effect.gen(function* () {
        reconciled.length = 0;
        yield* stack.deploy(program("a"));
        expect(reconciled).toEqual(["a"]);

        expect(actionOf(yield* stack.plan(program("a")), "Host")).toBe("noop");
        expect(actionOf(yield* stack.plan(program("b")), "Host")).toBe(
          "update",
        );

        yield* stack.deploy(program("b"));
        expect(reconciled).toEqual(["a", "b"]);
        expect(actionOf(yield* stack.plan(program("b")), "Host")).toBe("noop");
      }),
  );
});
