/**
 * A component is a declaration plus an implementation, the same split as an
 * Alchemy resource. The declaration names the component and its props; the
 * implementation is a Layer built from an effectful constructor that runs once
 * per mount, declares state and Intents, and returns the view.
 *
 * ```typescript
 * export class Hello extends Component.Tag<Hello>()("Hello") {}
 *
 * export const HelloLive = Hello.make(
 *   Effect.fn(function* () {
 *     const clicks = yield* Signal.state("clicks", 0);
 *     const clicked = yield* Intent.make("Clicked", clicks.update((n) => n + 1));
 *     return html.button({ onClick: clicked }, Signal.map(clicks, String));
 *   }),
 * );
 * ```
 *
 * Every `Signal.state` and `Intent.make` in the constructor is recorded in its
 * type, and `make` turns those records into the component's model, which
 * stories are type-checked against.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { Node } from "./html.ts";
import {
  type Declares,
  type Instance,
  Instance as InstanceImpl,
  type IntentDecl,
  Setup,
  type StateDecl,
} from "./internal/instance.ts";

/** What a component Layer provides: a way to create instances of it. */
export interface Factory<in out P> {
  readonly name: string;
  readonly create: (props: P) => Effect.Effect<Mounted, never, Scope.Scope>;
}

export interface Mounted {
  /** @internal */
  readonly instance: Instance;
  readonly view: Node;
}

/** Any component declaration. */
export type Key<Self, P> = Context.Key<Self, Factory<P>>;

/** The shape stories check against: the props, every Intent, and every piece of state. */
export interface Model {
  readonly props: unknown;
  readonly intents: { readonly [name: string]: unknown };
  readonly state: { readonly [name: string]: unknown };
}

type DeclsOf<R> = R extends Declares<infer D> ? D : never;

/** The services a constructor needs once its declarations are taken out. */
export type ServicesOf<R> = Exclude<R, Declares<any> | Setup>;

/** The model a constructor with requirements `R` declares. */
export type ModelOf<P, R> = {
  readonly props: P;
  readonly intents: {
    readonly [D in Extract<DeclsOf<R>, IntentDecl<string, any>> as D["name"]]: D["payload"];
  };
  readonly state: {
    readonly [D in Extract<DeclsOf<R>, StateDecl<string, any>> as D["name"]]: D["value"];
  };
};

declare const ModelTypeId: unique symbol;

/**
 * Carries a component's model in a Layer's output type. Nothing provides it at
 * runtime; it's there so the model survives `Layer.provide` and friends.
 */
export interface ModelOutput<out Self, out M extends Model> {
  readonly [ModelTypeId]: { readonly self: Self; readonly model: M };
}

/** A component implementation: an ordinary Layer whose output also names the model. */
export type ComponentLayer<Self, M extends Model, R> = Layer.Layer<
  Self | ModelOutput<Self, M>,
  never,
  R
>;

/** The model a Layer's output names for the component `Self`. */
export type ModelIn<ROut, Self> = ROut extends ModelOutput<Self, infer M> ? M : never;

export interface TagClass<Self, Name extends string, P> extends Context.ServiceClass<
  Self,
  Name,
  Factory<P>
> {
  readonly props: Schema.Schema<P> | undefined;
  /**
   * Implements the component. The constructor runs once per mount: it may
   * `yield*` services, branch, and declare state and Intents, and it returns
   * the view.
   */
  readonly make: <R>(
    constructor: (props: P) => Effect.Effect<Node, never, R>,
  ) => ComponentLayer<Self, ModelOf<P, R>, ServicesOf<R>>;
}

/** Declares a component. Pass `props` to give it props. */
export const Tag =
  <Self>() =>
  <const Name extends string, P = void>(
    name: Name,
    options: { readonly props?: Schema.Schema<P> } = {},
  ): TagClass<Self, Name, P> => {
    const Key = Context.Service<Self, Factory<P>>()(name);
    const make = <R>(constructor: (props: P) => Effect.Effect<Node, never, R>) =>
      Layer.effect(
        Key,
        Effect.map(Effect.context<ServicesOf<R>>(), (services): Factory<P> => ({
          name,
          create: (props) =>
            Effect.gen(function* () {
              const instance = new InstanceImpl(name, services as Context.Context<never>);
              yield* Effect.addFinalizer(() => instance.close());
              const view = yield* (
                constructor(props) as Effect.Effect<Node, never, Setup | ServicesOf<R>>
              ).pipe(Effect.provideService(Setup, instance), Effect.provideContext(services));
              return { instance, view };
            }),
        })),
      ) as unknown as ComponentLayer<Self, ModelOf<P, R>, ServicesOf<R>>;
    return Object.assign(Key, { props: options.props, make }) as unknown as TagClass<Self, Name, P>;
  };
