import { AdoptPolicy } from "alchemy/AdoptPolicy";
import { toFqn } from "alchemy/FQN";
import type { Input, InputProps, PropsInput } from "alchemy/Input";
import { CurrentNamespace, Namespace } from "alchemy/Namespace";
import type { Provider } from "alchemy/Provider";
import { ProviderModePolicy } from "alchemy/ProviderMode";
import { RemovalPolicy } from "alchemy/RemovalPolicy";
import { RenamePolicy } from "alchemy/Rename";
import {
  isResourceOfType,
  Resource,
  type ResourceClass,
  type ResourceLike,
  type ResourceOptions,
} from "alchemy/Resource";
import { StackContext } from "alchemy/StackContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ResourceGroup } from "./Resources/ResourceGroup.ts";

/**
 * The resource group that every Azure resource declared without a
 * `resourceGroup` prop is created in.
 *
 * By default a stack creates one group named `<stack>-<stage>` and deletes
 * it on destroy. Provide {@link resourceGroup} to deploy into another group.
 */
export class StackResourceGroup extends Context.Service<StackResourceGroup, Input<string>>()(
  "Azure::ResourceGroup",
) {}

/**
 * Deploy every resource without an explicit `resourceGroup` into `group`
 * instead of the stack's implicit `<stack>-<stage>` group.
 *
 * Pass a name to deploy into an existing group. Alchemy references the
 * group and never creates or deletes it, which suits subscriptions where
 * the deployer may not create resource groups:
 *
 * ```typescript
 * providers: Azure.providers().pipe(
 *   Layer.provideMerge(Azure.resourceGroup("rg-shop-prod")),
 * ),
 * ```
 *
 * Pass a `Azure.Resources.ResourceGroup` to manage the group yourself
 * (custom name, location, or tags):
 *
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app", {
 *   name: "shop-prod",
 *   location: "westeurope",
 * });
 * yield* program.pipe(Effect.provide(Azure.resourceGroup(group)));
 * ```
 *
 * A resource's ARM ID contains its group, so switching groups replaces
 * every resource that moves.
 */
export const resourceGroup = (group: Input<string> | ResourceGroup) =>
  Layer.succeed(StackResourceGroup, isResourceGroup(group) ? group.resourceGroupName : group);

const isResourceGroup = (group: Input<string> | ResourceGroup): group is ResourceGroup =>
  isResourceOfType(group, ResourceGroup.Type);

/** Logical ID of the stack's implicit resource group. */
export const DEFAULT_RESOURCE_GROUP_ID = "DefaultResourceGroup";

/**
 * Name of the stack's implicit resource group: `<stack>-<stage>`. Characters
 * ARM rejects become `-`, and the name stays within 80 characters (the
 * limit Front Door accepts) without a trailing `.`.
 */
export const defaultResourceGroupName = (stack: string, stage: string) =>
  `${stack}-${stage}`
    .replace(/[^A-Za-z0-9_().-]/g, "-")
    .slice(0, 80)
    .replace(/\.+$/, "");

/**
 * Policies a call site may carry that must not leak onto the implicit
 * group: it is shared by the whole stack, so the first resource that
 * registers it must not decide its namespace, removal policy, adoption,
 * former names, or provider mode.
 */
const atStackRoot = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.updateContext(
    effect,
    // Omitting optional policies never removes a service `effect` needs.
    (context: Context.Context<R>) =>
      Context.omit(
        Namespace,
        RemovalPolicy,
        AdoptPolicy,
        RenamePolicy,
        ProviderModePolicy,
      )(context) as Context.Context<R>,
  );

/**
 * Name of the resource group that resources without a `resourceGroup` prop
 * go into: the {@link StackResourceGroup} override, else the implicit
 * `<stack>-<stage>` group, registered on first use. `group` is the implicit
 * group's resource, or `undefined` when an override is in effect.
 */
export const stackResourceGroup = Effect.gen(function* () {
  const override = yield* Effect.serviceOption(StackResourceGroup);
  if (Option.isSome(override)) {
    return { name: override.value, group: undefined };
  }
  const stack = yield* StackContext;
  const group = yield* ResourceGroup(DEFAULT_RESOURCE_GROUP_ID, {
    name: defaultResourceGroupName(stack.name, stack.stage),
    deleteOnlyIfEmpty: true,
  }).pipe(atStackRoot);
  return { name: group.resourceGroupName, group };
});

/**
 * Props as callers write them: `resourceGroup` is optional and defaults to
 * the {@link StackResourceGroup}. Distributes over union props.
 */
export type WithDefaultResourceGroup<P> = P extends { resourceGroup: string }
  ? Omit<P, "resourceGroup"> & {
      /**
       * Resource group the resource is created in. Changing it replaces the
       * resource.
       * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
       */
      resourceGroup?: string;
    }
  : P;

type CallerProps<R extends ResourceLike> = WithDefaultResourceGroup<R["Props"]>;

export type GroupedResourceConstructor<R extends ResourceLike, Req> = {
  (
    id: string,
    ...args: {} extends CallerProps<R>
      ? [props?: PropsInput<CallerProps<R>>]
      : [props: PropsInput<CallerProps<R>>]
  ): Effect.Effect<R, never, Req>;
  <PropsReq = never>(
    id: string,
    props: Effect.Effect<InputProps<CallerProps<R>>, never, PropsReq>,
  ): Effect.Effect<R, never, PropsReq | Req>;
};

/**
 * A resource class whose constructor fills in `resourceGroup` from the
 * {@link StackResourceGroup}. Providers still see a resolved `resourceGroup`.
 */
export type GroupedResourceClass<R extends ResourceLike> = GroupedResourceConstructor<
  R,
  R["Providers"] extends undefined ? Provider<R> : R["Providers"]
> &
  ResourceClass<R>;

/**
 * Declare an Azure resource type that lives in a resource group, like
 * `alchemy/Resource`'s `Resource`, except that callers may omit
 * `resourceGroup`: the constructor then puts the resource in the
 * {@link StackResourceGroup} and, for the implicit group, depends on it so
 * the group is created first and deleted last.
 */
export const GroupedResource = <R extends ResourceLike>(
  type: R["Type"],
  options?: ResourceOptions,
): GroupedResourceClass<R> => {
  const base = Resource<R>(type, options);
  const withGroup = (props: Record<string, unknown> | undefined) =>
    props?.resourceGroup !== undefined
      ? Effect.succeed(props)
      : Effect.map(stackResourceGroup, ({ name }) => ({ ...props, resourceGroup: name }));
  const construct = (id: string, props: unknown) =>
    Effect.gen(function* () {
      const stack = yield* StackContext;
      // A repeat declaration returns the registered resource unchanged.
      if (stack.resources[toFqn(yield* CurrentNamespace, id)] !== undefined) {
        return yield* base(id, props as never);
      }
      return yield* base(
        id,
        (Effect.isEffect(props)
          ? Effect.flatMap(props, (resolved) =>
              withGroup(resolved as Record<string, unknown> | undefined),
            )
          : yield* withGroup(props as Record<string, unknown> | undefined)) as never,
      );
    });
  const cls: GroupedResourceClass<R> = Object.assign(
    (...args: [id: string, props: unknown] | [methods: object]) =>
      typeof args[0] === "object" ? Object.assign(cls, args[0]) : construct(args[0], args[1]),
    base,
    Effectable.Prototype({
      label: `Resource<${type}>`,
      evaluate: () => Effect.succeed(construct),
    }),
  ) as never;
  return cls;
};
