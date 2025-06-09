export type type<T> = typeof type<T>;
/**
 * Used to construct type-level alias information.
 */
export const type = ((): any => {
  throw new Error("Should never be called, purely for type-level aliasing");
}) as (<T>() => T) &
  // we also want to make this a "class type" so that syntax highlighting is always as a type
  (new <T>() => T);
