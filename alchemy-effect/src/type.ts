export type type<T> = new () => T;
export const type = class {} as new <T>() => T;
