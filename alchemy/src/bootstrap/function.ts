import { Worker } from "../cloudflare/worker.js";
import { ResourceFQN } from "../resource.js";
import { Scope } from "../scope.js";
import { env } from "./env.js";
import { bootstrapPlugin } from "./plugin.js";

export const PHASE = env.__PHASE__ ?? "build";

export type Function<T extends (...args: any[]) => any> = T & {
  meta: ImportMeta;
  type: "function";
  id: string;
  scope: Scope;
};

export async function Function<Fn extends (...args: any[]) => any>(
  meta: ImportMeta,
  id: string,
  fn: Fn,
  options?: {
    bindings?: Record<string, any>;
  },
) {
  const scope = Scope.get();
  if (!scope) {
    throw new Error(
      "Function must be called within a scope, did you forget to call `await alchemy(..)`?",
    );
  }
  const func = Object.assign(fn, {
    id,
    meta,
    type: "function",
    scope,
  } as Function<Fn>);
  const worker = await Worker(id, {
    entrypoint: meta.file,
    bundle: {
      // TODO: use a DEFINE in esbuild to conditionally erase this
      plugins: [bootstrapPlugin],
    },
    bindings: {
      ...options?.bindings,
    },
  });
  const slug = worker[ResourceFQN].replace(/[^A-Za-z0-9_]/g, "_");

  const { env } = await import("./env.js");

  const phase = ((env as any).__PHASE__ ?? "build") as "build" | "runtime";

  return new Proxy(() => {}, {
    apply(target, thisArg, argumentsList) {
      // if (phase === "build") {
      //   return worker.fetch(new Request(argumentsList[0]));
      // }
      // return worker.fetch(new Request(argumentsList[0]));
    },
    get(target, prop, receiver) {
      if (prop === "fetch") {
        return worker.fetch;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
