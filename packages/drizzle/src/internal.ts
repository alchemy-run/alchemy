const entityKind = Symbol.for("drizzle:entityKind");

/**
 * `proxyChain`'s `descend` for Drizzle clients. Walks the plain objects
 * Drizzle takes as arguments (select fields, row values) and Drizzle's own
 * entities (`SQL`, `SQL.Aliased`, …), where `` sql`count(${cte.id})` `` and
 * `eq(cte.parent, id)` store a deferred column. Binary data, dates and
 * other classes are left alone.
 */
export const descendDrizzle = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value);
  if (proto === null || proto === Object.prototype) return true;
  const ctor = proto.constructor;
  return typeof ctor === "function" && entityKind in ctor;
};
