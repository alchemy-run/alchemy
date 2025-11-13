import * as Context from "effect/Context";
import type { Effect } from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Capability, ICapability } from "./capability.ts";
import type { Diff } from "./provider.ts";
import type { Resource } from "./resource.ts";
import type { Runtime } from "./runtime.ts";

export interface BindingProps {
  [key: string]: any;
}

export const isBinding = (b: any): b is AnyBinding =>
  "runtime" in b && "capability" in b && "tag" in b && "output" in b;

export type AnyBinding<F extends Runtime = any> = Binding<
  F,
  any,
  any,
  any,
  string,
  boolean
>;

export interface Binding<
  Run extends Runtime<any, any, any>,
  Cap extends Capability = Capability,
  Props = any,
  Attr extends Run["binding"] = any,
  Tag extends string = Cap["type"],
  IsCustom extends boolean = Cap["type"] extends Tag ? false : true,
> {
  runtime: Run;
  capability: Cap;
  tag: Tag;
  props: Props;
  attr: Attr;
  isCustom: IsCustom;
}

/** Tag for a Service that can bind a Capability to a Runtime */
export interface Bind<
  F extends Runtime,
  Cap extends Capability,
  Tag extends string,
> extends Context.Tag<
    `${F["type"]}(${Cap["type"]}, ${Tag})`,
    BindingService<
      F,
      Extract<Extract<Cap["resource"], Resource>["parent"], Resource>,
      F["props"]
    >
  > {
  /** @internal phantom */
  name: Tag;
}

export const Binding: {
  <F extends (resource: any, props?: any) => AnyBinding & { isCustom: true }>(
    runtime: ReturnType<F>["runtime"],
    // resource: new () => ReturnType<F>["capability"]["resource"],
    type: ReturnType<F>["capability"]["type"],
    tag: ReturnType<F>["tag"],
  ): F & BindingDeclaration<ReturnType<F>["runtime"], F>;
  <F extends (resource: any, props?: any) => AnyBinding & { isCustom: false }>(
    runtime: ReturnType<F>["runtime"],
    // resource: new () => ReturnType<F>["capability"]["resource"],
    type: ReturnType<F>["capability"]["type"],
  ): F & BindingDeclaration<ReturnType<F>["runtime"], F>;
} = (runtime: any, cap: string, tag?: string) => {
  const Tag = Context.Tag(`${runtime.type}(${cap}, ${tag ?? cap})`)();
  return Object.assign(
    (resource: any, props?: any) =>
      ({
        runtime,
        capability: {
          type: cap,
          resource,
          constraint: undefined!,
          sid: `${cap}${resource.id}`.replace(/[^a-zA-Z0-9]/g, ""),
          label: `${cap}(${resource.id})`,
        } satisfies ICapability,
        props,
        isCustom: false,
        tag: tag ?? cap,
        // @ts-expect-error - we smuggle this property because it interacts poorly with inference
        Tag,
      }) satisfies Binding<any, any, any, any, string, false>,
    {
      provider: {
        effect: (eff) => Layer.effect(Tag, eff),
        succeed: (service) => Layer.succeed(Tag, service),
      },
    } satisfies BindingDeclaration<Runtime, any>,
  );
};

export interface BindingDeclaration<
  Run extends Runtime,
  F extends (target: any, props?: any) => AnyBinding<Run>,
  Tag extends string = ReturnType<F>["tag"],
  Cap extends Capability = ReturnType<F>["capability"],
> {
  provider: {
    effect<Err, Req>(
      eff: Effect<
        BindingService<
          Run,
          Parameters<F>[0],
          Parameters<F>[1],
          ReturnType<F>["attr"]
        >,
        Err,
        Req
      >,
    ): Layer.Layer<Bind<Run, Cap, Tag>, Err, Req>;
    succeed(
      service: BindingService<
        Run,
        Parameters<F>[0],
        Parameters<F>[1],
        ReturnType<F>["attr"]
      >,
    ): Layer.Layer<Bind<Run, Cap, Tag>>;
  };
}

export interface BindingDiffProps<
  Source extends Resource = Resource,
  Target extends Resource = Resource,
  Props = any,
  Attr = any,
> {
  source: {
    id: string;
    props: Source["props"];
    oldProps?: Source["props"];
    oldAttr?: Source["attr"];
  };
  props: Props;
  attr: Attr | undefined;
  target: {
    id: string;
    props: Target["props"];
    oldProps?: Target["props"];
    oldAttr?: Target["attr"];
  };
}

export interface BindingAttachProps<
  Source extends Resource,
  Target extends Resource,
  Props,
  Attr,
> {
  source: {
    id: string;
    attr: Source["attr"];
    props: Source["props"];
  };
  props: Props;
  attr: Attr | undefined;
  target: {
    id: string;
    props: Target["props"];
    attr: Target["attr"];
  };
}

export interface BindingReattachProps<
  Source extends Resource,
  Target extends Resource,
  Props,
  Attr,
> {
  source: {
    id: string;
    attr: Source["attr"];
    props: Source["props"];
  };
  props: Props;
  attr: Attr;
  target: {
    id: string;
    props: Target["props"];
    attr: Target["attr"];
  };
}

export interface BindingDetachProps<
  Source extends Resource,
  Target extends Resource,
  Props,
  Attr,
> {
  source: {
    id: string;
    attr: Source["attr"];
    props: Source["props"];
  };
  props: Props;
  attr: Attr | undefined;
  target: {
    id: string;
    props: Target["props"];
    attr: Target["attr"];
  };
}

export type BindingService<
  Target extends Runtime = any,
  Source extends Resource = Resource,
  Props = any,
  Attr extends Target["binding"] = any,
  DiffReq = never,
  PreReattachReq = never,
  AttachReq = never,
  ReattachReq = never,
  DetachReq = never,
  PostAttachReq = never,
> = {
  diff?: (
    props: BindingDiffProps<Source, Target, Props>,
  ) => Effect<Diff, never, DiffReq>;
  preattach?: (
    props: BindingAttachProps<Source, Target, Props, Attr>,
  ) => Effect<Partial<Target["attr"]>, never, PreReattachReq>;
  attach: (
    props: BindingAttachProps<Source, Target, Props, Attr>,
  ) => Effect<Attr, never, AttachReq> | Attr;
  postattach?: (
    props: BindingAttachProps<Source, Target, Props, Attr>,
  ) => Effect<Omit<Attr, keyof Target["binding"]>, never, PostAttachReq>;
  reattach?: (
    props: BindingReattachProps<Source, Target, Props, Attr>,
  ) => Effect<Attr, never, ReattachReq> | Attr;
  detach?: (
    props: BindingDetachProps<Source, Target, Props, Attr>,
  ) => Effect<void, never, DetachReq> | void;
};
