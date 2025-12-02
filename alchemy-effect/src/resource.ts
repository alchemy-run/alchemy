import * as Context from "effect/Context";
import type { Effect } from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Output } from "./output.ts";
import type { Provider, ProviderService } from "./provider.ts";
import type { IsAny } from "./util.ts";

export const isResource = (r: any): r is Resource => {
  return r && typeof r === "function" && "id" in r && "type" in r && "props" in r;
};

export type AnyResource = Resource<string, string, any, any>;

export interface IResource<
  Type extends string = string,
  ID extends string = string,
  Props = unknown,
  Attrs = unknown,
  Base = unknown,
> {
  id: ID;
  type: Type;
  Props: unknown;
  props: Props;
  base: Base;
  /** @internal phantom */
  attr: Attrs;
}

export interface Resource<
  Type extends string = string,
  ID extends string = string,
  Props = unknown,
  Attrs = unknown,
  Base = unknown,
> extends IResource<Type, ID, Props, Attrs, Base> {
  new (): Resource<Type, ID, Props, Attrs, Base>;

  import(stage: string): true extends IsAny<Attrs>
    ? {
        [attr in string | number | symbol]: Output<any>;
      }
    : unknown extends Attrs
      ? {
          [attr in string | number | symbol]: Output<any>;
        }
      : {
          [attr in keyof Attrs]: Output.Of<Attrs[attr]>;
        };

  /** @internal phantom */
  // dependencies: Input.Dependencies<Props>;

  // TODO(sam): figure out how to add this back in because people preferred it
  // ... but, it breaks resource types (e.g. class Table extends DynamoDB.Table("Table", { ... }) is not assignable to DynamoDB.Table<"Table", { ... }>)
  // out<Self extends Resource>(
  //   this: Self,
  // ): Output<
  //   {
  //     [k in keyof Attrs]: Attrs[k];
  //   },
  //   InstanceType<Self>
  // >;
  // parent: unknown;
  // oxlint-disable-next-line no-misused-new
}

export interface ResourceTags<R extends Resource<string, string, any, any>> {
  of<S extends ProviderService<R>>(service: S): S;
  tag: Provider<R>;
  effect<Err, Req>(eff: Effect<ProviderService<R>, Err, Req>): Layer.Layer<Provider<R>, Err, Req>;
  succeed(service: ProviderService<R>): Layer.Layer<Provider<R>>;
}

export const Resource = <Ctor extends (id: string, props: any) => Resource>(
  type: ReturnType<Ctor>["type"],
) => {
  const Tag = Context.Tag(type)();
  const provider: ResourceTags<ReturnType<Ctor>> = {
    tag: Tag as any,
    effect: <Err, Req>(eff: Effect<ProviderService<ReturnType<Ctor>>, Err, Req>) =>
      Layer.effect(Tag, eff),
    succeed: (service: ProviderService<ReturnType<Ctor>>) => Layer.succeed(Tag, service),
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
