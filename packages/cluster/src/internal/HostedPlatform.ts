/**
 * The Platform and provider behind a class runners host that callers never
 * address (a singleton, a cron): a resource whose only attribute is the
 * shard group of the runners that host it.
 *
 * @internal
 */
import type { InputProps } from "alchemy/Input";
import { Platform, type PlatformProps } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { EntityBindingContract } from "../Entity.ts";
import type { Providers } from "../Providers.ts";
import { type HostedRuntimeContext, makeHostedRuntimeContext } from "./HostedRuntime.ts";

export interface HostedProps extends PlatformProps {
  /** The module whose default export is this class's Layer. Usually `import.meta.url`. */
  main: string;
}

export interface HostedAttributes {
  /** The shard group of the runners that host it. */
  runners: string | undefined;
}

export interface HostedResource<
  Type extends string,
  Props extends HostedProps = HostedProps,
> extends Resource<Type, Props, HostedAttributes, EntityBindingContract, Providers> {}

export const makeHostedPlatform = <
  Type extends string,
  Hosted,
  Props extends HostedProps = HostedProps,
>(
  typeId: Type,
  build: (id: string, returned: unknown, context: Context.Context<never>, props: Props) => Hosted,
  check?: (id: string, context: Context.Context<never>, props: Props) => Effect.Effect<void>,
) => {
  const platform = Platform(typeId, {
    createRuntimeContext: makeHostedRuntimeContext<Hosted>(typeId, build, check),
  }) as unknown as Platform<
    HostedResource<Type, Props>,
    any,
    unknown,
    HostedRuntimeContext<Hosted>
  >;

  const provider = () =>
    Provider.succeed(platform, {
      stables: [],
      reconcile: ({ bindings }) =>
        Effect.sync(() => {
          const attrs: HostedAttributes = { runners: undefined };
          for (const { data } of bindings) attrs.runners = data.runners ?? attrs.runners;
          return attrs;
        }),
      delete: () => Effect.void,
    });

  /** The class: a declaration with `.make(props, impl)`, its implementation as a Layer. */
  const declare = (id: string, members: object) => {
    const tag = (platform as any)()(id);
    return Object.assign(class {}, members, {
      LogicalId: id,
      make: (props: InputProps<Props>, impl: unknown) =>
        tag.make(props, impl) as Layer.Layer<never, never, any>,
    });
  };

  return { platform, provider, declare };
};
