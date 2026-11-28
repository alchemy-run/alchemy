/**
 * A declaration's props, given directly or as a thunk. A thunk is read the
 * first time the declaration is used, not when its module loads, so two
 * modules that import each other can each list the other: by the time
 * either is used, both have loaded.
 *
 * Use one only to break an import cycle. Given directly, props are checked
 * when the module loads, which reports a mistake sooner.
 *
 * @module
 */

/** A value, or a function that returns it, read the first time it is needed. */
export type Thunk<A> = A | (() => A);

/** Whether props were given as a thunk. Props themselves are never functions. */
export const isThunk = <A>(given: Thunk<A>): given is () => A => typeof given === "function";

/** Read the props once, the first time they are needed. */
export const memo = <A>(given: Thunk<A>): (() => A) => {
  if (!isThunk(given)) return () => given;
  let read: { readonly value: A } | undefined;
  return () => (read ??= { value: given() }).value;
};

/**
 * A class whose static members are only known once its props are read: a
 * property it does not have yet reads the props, which add it, and is
 * then looked up again. Used where props given as a thunk name members of
 * the class, such as a model's mentions.
 */
export const withLateMembers = <C extends object>(cls: C, read: () => void): C => {
  // Only a name can be a member: a symbol, or `then` (asked of anything that
  // might be a promise), is answered without reading the props.
  const late = (target: C, property: string | symbol) =>
    typeof property === "string" && property !== "then" && !Reflect.has(target, property);
  return new Proxy(cls, {
    get: (target, property, receiver) => {
      if (late(target, property)) read();
      return Reflect.get(target, property, receiver);
    },
    has: (target, property) => {
      if (late(target, property)) read();
      return Reflect.has(target, property);
    },
  });
};

/**
 * A class made the first time it is used. Extending it reads nothing: a
 * subclass gets this stand-in's own prototype, and every other property,
 * symbols included, is the made class's.
 */
export const withLateClass = <C extends object>(made: () => C): C => {
  const standIn = class {};
  return new Proxy(standIn, {
    get: (target, property) =>
      property === "prototype" ? target.prototype : Reflect.get(made(), property),
    has: (_, property) => Reflect.has(made(), property),
    ownKeys: () => Reflect.ownKeys(made()),
    getOwnPropertyDescriptor: (target, property) =>
      property === "prototype"
        ? Reflect.getOwnPropertyDescriptor(target, property)
        : Reflect.getOwnPropertyDescriptor(made(), property),
  }) as unknown as C;
};
