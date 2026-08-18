import * as Effect from "effect/Effect";
import type * as ViteModule from "vite";
import { describe, expect, it } from "vitest";
import {
  makeWakuCloudflareTarget,
  makeWakuPluginOptions,
  WEBSITE_ENTRY_ID,
} from "../cloudflare.ts";
import {
  makeWakuEffectEntrySource,
  wakuEffectEntryPlugin,
} from "../effect-entry.ts";
import { selectWakuTargetInput, WAKU_SERVER_ENTRY_ID } from "../Waku.ts";

const WAKU_DIR = "/project/node_modules/waku";

const flatten = (
  plugins: ReadonlyArray<ViteModule.PluginOption>,
): Array<ViteModule.Plugin> =>
  (plugins as Array<unknown>)
    .flat(8)
    .filter(
      (plugin): plugin is ViteModule.Plugin =>
        typeof plugin === "object" && plugin !== null && "name" in plugin,
    );

describe("makeWakuEffectEntrySource", () => {
  it("generates the maximal wrapper (DOs + workflows) from plan-time data", () => {
    const source = makeWakuEffectEntrySource({
      main: "/project/src/backend.ts",
      durableObjects: ["Counter", "Rooms"],
      workflows: ["ReportWorkflow"],
    });
    // Import order is load-bearing: alchemy/Cloudflare/Serve stamps
    // __ALCHEMY_RUNTIME__ before the user's site module evaluates.
    expect(source.indexOf('from "alchemy/Cloudflare/Serve"')).toBeLessThan(
      source.indexOf('"/project/src/backend.ts"'),
    );
    // Waku's fetch is grafted verbatim via the stable server-entry seam.
    expect(source).toContain(JSON.stringify(WAKU_SERVER_ENTRY_ID));
    expect(source).toContain("makeWebsiteEntryExports(WorkerEntrypoint, {");
    expect(source).toContain(
      "fetch: (request, env, ctx) => __wakuEntry.fetch(request, env, ctx)",
    );
    // Class exports are printed from registration, one per class.
    expect(source).toContain(
      'export class Counter extends __alchemyDurableObjectBridge("Counter") {}',
    );
    expect(source).toContain(
      'export class Rooms extends __alchemyDurableObjectBridge("Rooms") {}',
    );
    expect(source).toContain(
      'export class ReportWorkflow extends __alchemyWorkflowBridge("ReportWorkflow") {}',
    );
  });

  it("omits the bridge scaffolding when the program registered no classes", () => {
    const source = makeWakuEffectEntrySource({ main: "/p/src/backend.ts" });
    expect(source).not.toContain("DurableObjectBridge");
    expect(source).not.toContain("WorkflowBridge");
    expect(source).toContain("makeWebsiteEntryExports");
  });
});

describe("effectful plugin options", () => {
  it("pins main to the virtual wrapper id on the effect arm", () => {
    const options = makeWakuPluginOptions({
      root: "/project",
      wakuDirectory: WAKU_DIR,
      effect: { main: "/project/src/backend.ts" },
    });
    expect(options.main).toBe(WEBSITE_ENTRY_ID);
    expect(options.viteEnvironments).toEqual({
      entry: "rsc",
      children: ["ssr"],
    });
  });

  it("surfaces the virtual wrapper as the target's entry and injects the plugin", async () => {
    const target = makeWakuCloudflareTarget({
      compatibilityDate: "2026-03-10",
      effect: { main: "/project/src/backend.ts", durableObjects: ["Counter"] },
    });
    expect(target.entry).toEqual({ main: WEBSITE_ENTRY_ID });
    const plugins = flatten(
      await Effect.runPromise(
        target.vitePlugins({
          root: "/project",
          wakuDirectory: WAKU_DIR,
          phase: "build",
        }),
      ),
    );
    expect(plugins.map((plugin) => plugin.name)).toContain(
      "alchemy:waku-website-entry",
    );
  });
});

describe("wakuEffectEntryPlugin", () => {
  const plugin = wakuEffectEntryPlugin({
    effect: { main: "/project/src/backend.ts", durableObjects: ["Counter"] },
    environments: ["rsc", "ssr"],
  });

  it("resolves and loads the virtual wrapper module", () => {
    const resolved = (plugin.resolveId as (id: string) => string | undefined)(
      WEBSITE_ENTRY_ID,
    );
    expect(resolved).toBe(`\0${WEBSITE_ENTRY_ID}`);
    const source = (plugin.load as (id: string) => string | undefined)(
      resolved!,
    );
    expect(source).toContain("makeWebsiteEntryExports");
    expect(source).toContain('__alchemyDurableObjectBridge("Counter")');
  });

  it("defines the runtime flag only in the worker environments", () => {
    const configEnvironment = plugin.configEnvironment as (
      name: string,
    ) => { define?: Record<string, string> } | undefined;
    expect(configEnvironment("rsc")?.define).toEqual({
      "globalThis.__ALCHEMY_RUNTIME__": "true",
    });
    expect(configEnvironment("ssr")?.define).toEqual({
      "globalThis.__ALCHEMY_RUNTIME__": "true",
    });
    expect(configEnvironment("client")).toBeUndefined();
  });
});

describe("selectWakuTargetInput", () => {
  it("folds the effect descriptor into the target config", () => {
    const { input, config } = selectWakuTargetInput({
      target: "@alchemy.run/frontend-frameworks/waku/aws",
      effect: { main: "/p/src/backend.ts" },
    });
    expect(input).toBe("@alchemy.run/frontend-frameworks/waku/aws");
    expect(config).toEqual({ effect: { main: "/p/src/backend.ts" } });
  });

  it("keeps the base config alongside the effect descriptor", () => {
    const { config } = selectWakuTargetInput({
      vite: { compatibilityDate: "2026-03-10" },
      effect: { main: "/p/src/backend.ts" },
    });
    expect(config).toEqual({
      compatibilityDate: "2026-03-10",
      effect: { main: "/p/src/backend.ts" },
    });
  });

  it("stays absent for plain sites", () => {
    const { config } = selectWakuTargetInput({});
    expect(config).toBeUndefined();
  });
});
