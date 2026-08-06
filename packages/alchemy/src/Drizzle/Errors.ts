// The tagged errors drizzle's effect drivers fail with — re-exported so
// consumers can reference them without reaching into drizzle-orm
// internals. (`Effect.catchTag` needs only the tag string; these are for
// instanceof checks, schemas, and annotations.)
export {
  EffectDrizzleError,
  EffectDrizzleQueryError,
  EffectTransactionRollbackError,
  MigratorInitError,
} from "drizzle-orm/effect-core";
