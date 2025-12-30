import * as Context from "effect/Context";
import type { Effect } from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Provider, ProviderService } from "./provider.ts";
import type { InstanceId } from "./instance-id.ts";

export const isResource = (r: any): r is Resource => {
  return (
    r && typeof r === "function" && "id" in r && "type" in r && "props" in r
  );
};

export type AnyResource = Resource<string, string, any, any>;

export interface IResource<
  Type extends string = string,
  ID extends string = string,
  Props = unknown,
  Attrs = unknown,
  Base = unknown,
  Binding = unknown,
> {
  id: ID;
  type: Type;
  Props: unknown;
  props: Props;
  base: Base;
  /** @internal phantom */
  attr: Attrs;
  binding: Binding;
}

export interface Resource<
  Type extends string = string,
  ID extends string = string,
  Props = unknown,
  Attrs = unknown,
  Base = unknown,
  Binding = unknown,
> extends IResource<Type, ID, Props, Attrs, Base, Binding> {
  new (): Resource<Type, ID, Props, Attrs, Base, Binding>;
}

export interface ResourceTags<R extends Resource<string, string, any, any>> {
  of<S extends ProviderService<R>>(service: S): S;
  tag: Provider<R>;
  effect<
    Err,
    Req,
    ReadReq = never,
    DiffReq = never,
    PrecreateReq = never,
    CreateReq = never,
    UpdateReq = never,
    DeleteReq = never,
  >(
    eff: Effect<
      ProviderService<
        R,
        ReadReq,
        DiffReq,
        PrecreateReq,
        CreateReq,
        UpdateReq,
        DeleteReq
      >,
      Err,
      Req
    >,
  ): Layer.Layer<
    Provider<R>,
    Err,
    Exclude<
      | Req
      | ReadReq
      | DiffReq
      | PrecreateReq
      | CreateReq
      | UpdateReq
      | DeleteReq,
      InstanceId
    >
  >;
  succeed<
    ReadReq = never,
    DiffReq = never,
    PrecreateReq = never,
    CreateReq = never,
    UpdateReq = never,
    DeleteReq = never,
  >(
    service: ProviderService<
      R,
      ReadReq,
      DiffReq,
      PrecreateReq,
      CreateReq,
      UpdateReq,
      DeleteReq
    >,
  ): Layer.Layer<
    Provider<R>,
    never,
    Exclude<
      ReadReq | DiffReq | PrecreateReq | CreateReq | UpdateReq | DeleteReq,
      InstanceId
    >
  >;
}

export const Resource = <Ctor extends (id: string, props: any) => Resource>(
  type: ReturnType<Ctor>["type"],
) => {
  const Tag = Context.Tag(type)();
  const provider: ResourceTags<ReturnType<Ctor>> = {
    tag: Tag as any,
    effect: (eff) => Layer.effect(Tag, eff),
    succeed: (service: ProviderService<ReturnType<Ctor>>) =>
      Layer.succeed(Tag, service),
    of: (service) => service,
  } as ResourceTags<ReturnType<Ctor>>;
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
      parent: ReturnType<Ctor>;
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
