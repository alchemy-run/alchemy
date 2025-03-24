import type { Context } from ".";
// import type { Bindings } from "./cloudflare/bindings";
// import type { Bound } from "./cloudflare/bound";

type Export<T extends (...args: any[]) => any> = Awaited<ReturnType<T>>;

export type Env = Outputs["Env"];

export type Outputs = Export<typeof alchemize>;

export default async function alchemize() {
  const kv = await KVNamespace("my-kv", {
    title: "my-kv",
  });

  const worker = await Worker("my-worker", {
    bindings: {
      AUTH_STORE: kv,
      MY_BINDING: "my-binding",
      ID: kv.namespaceId,
    },
  });

  return worker;
}

export type Bindings = {
  [key: string]: any;
};

function output<T>(t: () => Promise<T>): Output<T> {
  return t as any;
}

type Output<T> = Promise<T> & {
  [prop in keyof T]: Promise<T[prop]>;
};

type Input<T> = {
  [key in keyof T]: T[key] | Output<T[key]>;
};

type IsClass = {
  new (_: never): never;
};

type Resource<
  Type extends string,
  F extends (this: Context<any>, id: string, props: Input<any>) => any,
> = F & {
  type: Type;
  new (...params: Parameters<F>): ReturnType<F>;
};

export function Resource<
  const Type extends string,
  F extends (this: Context<any>, id: string, props: any) => any,
>(type: Type, fn: F) {
  const resource = function (id: string, input: any) {
    return fn.bind(this)(id, input);
  } as Resource<Type, F>;
  resource.type = type;
  return resource as Resource<Type, F>;
}

export interface Worker<B extends Bindings> {
  workerId: string;
  url: string;
  Env: {
    [bindingName in keyof B]: any;
  };
}

export const Worker = Resource(
  "cloudflare::Worker",
  function <const B extends Bindings>(
    this: Context<Worker<B>> | void,
    id: string,
    input: Input<{
      bindings: B;
    }>,
  ): Output<Worker<B>> {
    return output(async () => {
      if (this!.event === "delete") {
        throw new Error("Not implemented");
      }
      return {
        workerId: id,
        Env: input.bindings,
        url: `https://${id}.${this!.stage}.workers.dev`,
      };
    });
  },
);

export interface KVNamespace {
  title: string;
  namespaceId: string;
}

export const KVNamespace = Resource(
  "cloudflare::KVNamespace",
  function (
    this: Context<KVNamespace> | void,
    id: string,
    input: Input<{
      title: string;
    }>,
  ): Output<KVNamespace> {
    return output(async () => {
      if (this!.event === "delete") {
        throw new Error("Not implemented");
      }

      return {
        title: await input.title,
        namespaceId: id,
      };
    });
  },
);
