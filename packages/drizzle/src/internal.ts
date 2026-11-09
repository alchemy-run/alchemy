const entityKind = Symbol.for("drizzle:entityKind");

/**
 * The SQL building blocks a deferred column can hide in. Everything else
 * (tables, columns, query builders, sessions) is left alone: schema is built
 * at module scope, and builders and sessions hold the live client.
 */
const sqlKinds = new Set(["SQL", "SQL.Aliased", "Param", "ValueRows"]);

const walkable = new WeakMap<Function, boolean>();

const isSqlEntity = (ctor: Function): boolean => {
  let result = walkable.get(ctor);
  if (result === undefined) {
    result = false;
    for (let cls: any = ctor; cls; cls = Object.getPrototypeOf(cls)) {
      if (Object.hasOwn(cls, entityKind) && sqlKinds.has(cls[entityKind])) {
        result = true;
        break;
      }
    }
    walkable.set(ctor, result);
  }
  return result;
};

/**
 * `proxyChain`'s `descend` for Drizzle clients. Walks the plain objects
 * Drizzle takes as arguments (select fields, row values), Drizzle's query
 * entities (`SQL`, `SQL.Aliased`, …), where `` sql`count(${cte.id})` `` and
 * `eq(cte.parent, id)` store a deferred column, and callbacks such as
 * `.where(() => eq(cte.id, id))`. Tables, columns, query builders, binary
 * data, dates and other classes are skipped.
 *
 * Known gap: Drizzle encodes a compared value with its column's encoder when
 * the comparison is built, so `eq(cte.col, value)` with a deferred column
 * binds `value` unencoded. Columns whose encoder changes the value (custom
 * types, dates or booleans on SQLite) need `eq(cte.col, sql.param(value, cte.col))`.
 */
export const descendDrizzle = (value: object): boolean => {
  if (typeof value === "function") return !(entityKind in value);
  const proto = Object.getPrototypeOf(value);
  if (proto === null || proto === Object.prototype) return true;
  const ctor = proto.constructor;
  return typeof ctor === "function" && isSqlEntity(ctor);
};
