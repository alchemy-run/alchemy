import * as ServiceMap from "effect/ServiceMap";

export const GenericService =
  <
    Fn extends (T: { Type: string }) => ServiceMap.Service<any, any> = (
      ...args: any[]
    ) => ServiceMap.Service<any, any>,
  >() =>
  <Kind extends string>(Kind: string): ReturnType<Fn> & Fn => {
    const service = ServiceMap.Service<any, any>(Kind);
    const make = (Type: string) => ServiceMap.Service(`${Kind}<${Type}>`);
    return Object.assign(
      Object.setPrototypeOf(make, service),
      service,
    ) as ReturnType<Fn> & Fn;
  };
