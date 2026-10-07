import * as Cloudflare from "@/Cloudflare";
import type { Counter } from "./WorkerExportsModule.ts";

type Main = typeof import("./WorkerExportsModule.ts");

// Everything is declared inline: the helpers only inspect the keys they are
// given, and `WorkerEnv` is an interface, so the module's classes (which
// extend `DurableObject<WorkerEnv>`) do not force the Worker's type early.
export const Worker = Cloudflare.Worker("WorkerExportsTypeProbe", {
  main: "./WorkerExportsModule.ts",
  exports: Cloudflare.Exports<Main>()({
    Counter: {},
    Legacy: { storage: "legacy-kv" },
    CachedRead: { cache: { enabled: true } },
    Retired: { state: "deleted" },
  }),
  env: {
    Counter: Cloudflare.DurableObject<Counter>("Counter"),
    MCP: Cloudflare.Workers.SelfEntrypoint<Main>()("CachedRead"),
  },
});

export interface WorkerEnv extends Cloudflare.InferEnv<typeof Worker> {}

declare const env: WorkerEnv;
export const _increment: Promise<number> = env.Counter.getByName("x").increment();
export const _self: Promise<Response> = env.MCP.fetch("https://self.internal");

type GlobalProps = Cloudflare.InferGlobalProps<Main>;
export const _mainModule: GlobalProps["mainModule"] = {} as Main;
export const _durableNamespaces: GlobalProps["durableNamespaces"][] = ["Counter", "Legacy"];
// @ts-expect-error Entrypoints are not Durable Object namespaces.
export const _notNamespace: GlobalProps["durableNamespaces"] = "CachedRead";

// @ts-expect-error A misspelled export name must be a `deleted` tombstone.
Cloudflare.Exports<Main>()({ Countr: {} });
// @ts-expect-error Durable Objects do not take entrypoint settings.
Cloudflare.Exports<Main>()({ Counter: { cache: { enabled: true } } });
// @ts-expect-error Entrypoints do not take Durable Object settings.
Cloudflare.Exports<Main>()({ CachedRead: { storage: "sqlite" } });
// @ts-expect-error Exports that are not classes cannot be declared.
Cloudflare.Exports<Main>()({ helper: {} });
// @ts-expect-error A class still in the module cannot be deleted.
Cloudflare.Exports<Main>()({ Counter: { state: "deleted" } });
// @ts-expect-error A Durable Object is not a self entrypoint.
Cloudflare.Workers.SelfEntrypoint<Main>()("Counter");
// @ts-expect-error Unknown self entrypoints are rejected.
Cloudflare.Workers.SelfEntrypoint<Main>()("Missing");

// Bare `Self` still targets the default export.
export const _bareSelf = Cloudflare.Worker("WorkerExportsBareSelf", {
  main: "./WorkerExportsModule.ts",
  env: { SELF: Cloudflare.Workers.Self },
});
declare const bareEnv: Cloudflare.InferEnv<typeof _bareSelf>;
export const _bareFetch: Promise<Response> = bareEnv.SELF.fetch("https://self.internal");
