export declare namespace Resource {
  export type Kind = string;
  export type ID = string;
  export type Props = Record<string, any>;
  export type Attr = Record<string, any>;
  export type Platform = string;

  export type Type<
    Type extends string = string,
    Props extends Resource.Props = Resource.Props,
    Attr extends Resource.Attr = Resource.Attr,
  > = {
    Kind: "Resource";
    Type: Type;
    Props: Props;
    Attr: Attr;
    // new (self: any): {};
    <const ID extends string, const P extends Props>(
      id: ID,
      props: P,
    ): Resource<Type, ID, P, Attr>;
  };
}

export type InstanceOf<T extends { Kind: "Resource" }> = ReturnType<
  Extract<T, (...args: any) => any>
>;

export const Resource =
  <const Type extends string>(type: Type) =>
  <F extends (props: any) => Resource.Attr>() => {
    type Props = Parameters<F>[0];
    type Attr = ReturnType<F>;
    return Object.assign(
      <const ID extends string, P extends Props>(id: ID, props: P) =>
        Object.assign(class {}, {
          type,
          id,
          props,
          attr: undefined! as Attr,
        }) as any as Resource<Type>,
      {
        Type: type,
        Props: undefined! as Props,
        Attr: undefined! as Attr,
      },
    ) as any as F;
  };

export type Resource<
  Type extends Resource.Kind = Resource.Kind,
  ID extends Resource.ID = Resource.ID,
  Props extends Resource.Props = Resource.Props,
  Attr extends Resource.Attr = Resource.Attr,
  Platform extends Resource.Platform = Resource.Platform,
> = {
  Kind: "Resource";
  Type: Type;
  ID: ID;
  Props: Props;
  /** @internal phantom type */
  Attr: Attr;
  Platform: Platform;
  new (): {};
};
