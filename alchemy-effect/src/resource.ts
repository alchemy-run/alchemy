import * as Context from "effect/Context";
import type { Effect } from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Provider, ProviderService } from "./provider.ts";

export const isResource = (r: any): r is Resource => {
  return (
    r && typeof r === "function" && "id" in r && "type" in r && "props" in r
  );
};

export interface Resource<
  Type extends string = string,
  ID extends string = string,
  Props = unknown,
  Attrs = unknown,
> {
  id: ID;
  type: Type;
  props: Props;
  attr: Attrs;
  parent: unknown;
  // oxlint-disable-next-line no-misused-new
  new (): Resource<Type, ID, Props, Attrs>;
}

export interface ResourceTags<R extends Resource> {
  of<S extends ProviderService<R>>(service: S): S;
  tag: Context.TagClass<Provider<R>, R["type"], ProviderService<R>>;
  effect<Err, Req>(
    eff: Effect<ProviderService<R>, Err, Req>,
  ): Layer.Layer<Provider<R>, Err, Req>;
  succeed(service: ProviderService<R>): Layer.Layer<Provider<R>>;
}

export const Resource = <Ctor extends (id: string, props: any) => Resource>(
  type: ReturnType<Ctor>["type"],
) => {
  const Tag = Context.Tag(type)();
  const provider: ResourceTags<ReturnType<Ctor>> = {
    tag: Tag as any,
    effect: <Err, Req>(
      eff: Effect<ProviderService<ReturnType<Ctor>>, Err, Req>,
    ) => Layer.effect(Tag, eff),
    succeed: (service: ProviderService<ReturnType<Ctor>>) =>
      Layer.succeed(Tag, service),
    of: (service) => service,
  };
  return Object.assign(
    function (id: string, props: any) {
      return class Resource {
        static readonly id = id;
        static readonly type = type;
        static readonly props = props;
        static readonly provider = provider;
      };
    } as unknown as Ctor & {
      type: ReturnType<Ctor>["type"];
      new (): ReturnType<Ctor> & {
        parent: ReturnType<Ctor>;
      };
      provider: typeof provider;
    },
    {
      type: type,
      provider,
    },
  );
};
