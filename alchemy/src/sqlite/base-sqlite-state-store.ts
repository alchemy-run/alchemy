import { and, eq, getTableColumns, inArray } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import path from "node:path";
import type { Scope } from "../scope.ts";
import type { State, StateStore } from "../state.ts";
import * as schema from "./schema.ts";

type Database = BaseSQLiteDatabase<any, any, typeof schema>;

export interface SQLiteStateStoreOptions<T extends Database = Database> {
  create: () => Promise<T>;
}

const { scope: _, ...columns } = getTableColumns(schema.resources);

export class BaseSQLiteStateStore<T extends Database = Database>
  implements StateStore
{
  private chain: string[];
  private create: () => Promise<T>;
  private dbPromise?: Promise<T>;

  constructor(
    private readonly scope: Scope,
    options: SQLiteStateStoreOptions<T>,
  ) {
    this.chain = this.scope.chain;
    this.create = options.create;
  }

  private async db() {
    this.dbPromise ??= withExponentialBackoff("init", () => this.create());
    return await this.dbPromise;
  }

  async init() {
    await this.db();
  }

  async list() {
    const ids = await this.run("list", (db) =>
      db
        .select({ id: schema.resources.id })
        .from(schema.resources)
        .where(eq(schema.resources.scope, this.chain)),
    );
    return ids.map((id) => id.id);
  }

  async count() {
    return await this.run("count", (db) =>
      db.$count(
        db
          .select({ id: schema.resources.id })
          .from(schema.resources)
          .where(eq(schema.resources.scope, this.chain)),
      ),
    );
  }

  async get(id: string) {
    const [state] = await this.run("get", (db) =>
      db
        .select(columns)
        .from(schema.resources)
        .where(
          and(
            eq(schema.resources.id, id),
            eq(schema.resources.scope, this.chain),
          ),
        ),
    );
    if (!state) {
      return;
    }
    return await this.deserialize(state);
  }

  async getBatch(ids: string[]) {
    const states = await this.run("getBatch", async (db) =>
      db
        .select(columns)
        .from(schema.resources)
        .where(
          and(
            inArray(schema.resources.id, ids),
            eq(schema.resources.scope, this.chain),
          ),
        ),
    );
    return await this.deserializeMany(states);
  }

  async all() {
    const states = await this.run("all", async (db) =>
      db
        .select(columns)
        .from(schema.resources)
        .where(eq(schema.resources.scope, this.chain)),
    );
    return await this.deserializeMany(states);
  }

  async set(_: string, state: State) {
    const serialized = await this.serialize(state);
    await this.run("set", (db) =>
      db
        .insert(schema.resources)
        .values({
          ...serialized,
          scope: this.chain,
        })
        .onConflictDoUpdate({
          target: [schema.resources.id, schema.resources.scope],
          set: serialized,
        }),
    );
  }

  async delete(id: string) {
    await this.run("delete", async (db) =>
      db
        .delete(schema.resources)
        .where(
          and(
            eq(schema.resources.id, id),
            eq(schema.resources.scope, this.chain),
          ),
        ),
    );
  }

  private async run<U>(
    label: string,
    fn: (db: T) => Promise<U>,
    attempt = 0,
  ): Promise<U> {
    const db = await this.db();
    return await withExponentialBackoff(label, () => fn(db), attempt);
  }

  private async deserialize(
    state: Omit<schema.Resource, "scope">,
  ): Promise<State> {
    const { deserialize } = await import("../serde.ts"); // dynamic import to avoid circular dependency
    return await deserialize(this.scope, {
      ...state,
      oldProps: state.oldProps ?? undefined,
    });
  }

  private async serialize(state: State) {
    const { serialize } = await import("../serde.ts");
    return await serialize(this.scope, state);
  }

  private async deserializeMany(states: Omit<schema.Resource, "scope">[]) {
    const deserialized = await Promise.all(
      states.map((state) => this.deserialize(state)),
    );
    const map: Record<string, State> = {};
    for (const state of deserialized) {
      map[state.id] = state;
    }
    return map;
  }
}

const withExponentialBackoff = async <T>(
  label: string,
  fn: () => Promise<T>,
  attempt = 0,
): Promise<T> => {
  try {
    const result = await fn();
    return result;
  } catch (cause) {
    if (attempt < 10) {
      await delay(attempt);
      return withExponentialBackoff(label, fn, attempt + 1);
    }
    throw new Error(
      `[SQLiteStateStore] Failed to run "${label}" after 10 attempts`,
      {
        cause,
      },
    );
  }
};

const delay = (attempt: number, initialDelay = 100, jitterFactor = 0.2) => {
  const baseDelay = initialDelay * 2 ** attempt;
  const jitter = Math.floor(Math.random() * baseDelay * jitterFactor);
  return new Promise((resolve) => setTimeout(resolve, baseDelay + jitter));
};

export const resolveMigrationsPath = () => {
  return path.join(import.meta.dirname, "..", "..", "drizzle");
};
