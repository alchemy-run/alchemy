export type Inputs<P extends any[]> = P extends [infer First, ...infer Rest]
  ? [Input<First>, ...Inputs<Rest>]
  : [];

export type Input<T = any> = T | Promise<T>;
// | (T extends Promise<infer U>
//     ? U
//     : T extends (infer I)[]
//       ? number extends T["length"]
//         ? I[]
//         : Inputs<T>
//       : T extends object
//         ? {
//             [k in keyof T]: Input<T[k]>;
//           }
//         : never);
