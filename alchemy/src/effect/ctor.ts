export type Ctor<T = any> = new (_: never) => T;

export type Instance<T> = T extends new (_: never) => infer R ? R : never;
