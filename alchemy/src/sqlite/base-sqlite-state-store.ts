import { and, eq, getTableColumns, inArray } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import path from "node:path";
import type { Scope } from "../scope.ts";
import { deserialize, serialize } from "../serde.ts";
import type { State, StateStore } from "../state.ts";
import * as schema from "./schema.ts";

type Database = BaseSQLiteDatabase<any, any, typeof schema>;

interface DatabaseWithDestroy<T extends Database = Database> {
  db: T;
  destroy?: () => Promise<void>;
}

export interface SQLiteStateStoreOptions<T extends Database = Database> {
  create: () => Promise<DatabaseWithDestroy<T>>;
}

const { scope: _, ...columns } = getTableColumns(schema.resources);

export class BaseSQLiteStateStore<T extends Database = Database>
  implements StateStore
{
  private create: () => Promise<DatabaseWithDestroy<T>>;
  private dbPromise?: Promise<DatabaseWithDestroy<T>>;

  constructor(
    private readonly scope: Scope,
    options: SQLiteStateStoreOptions<T>,
  ) {
    this.create = options.create;
  }

  private get chain() {
    return this.scope.chain;
  }

  private async db() {
    this.dbPromise ??= this.create();
    const { db } = await this.dbPromise;
    return db;
  }

  async init() {
    await this.db();
  }

  async deinit() {
    if (!this.dbPromise) {
      return;
    }
    const { db, destroy } = await this.dbPromise;
    if (destroy) {
      const resourceCount = await db.$count(schema.resources);
      if (resourceCount === 0) {
        await destroy();
      }
    }
  }

  async list() {
    const db = await this.db();
    const ids = await db
      .select({ id: schema.resources.id })
      .from(schema.resources)
      .where(eq(schema.resources.scope, this.chain));
    return ids.map((id) => id.id);
  }

  async count() {
    const db = await this.db();
    return await db.$count(
      db
        .select({ id: schema.resources.id })
        .from(schema.resources)
        .where(eq(schema.resources.scope, this.chain)),
    );
  }

  async get(id: string) {
    const db = await this.db();
    const [state] = await db
      .select(columns)
      .from(schema.resources)
      .where(
        and(
          eq(schema.resources.id, id),
          eq(schema.resources.scope, this.chain),
        ),
      );
    if (!state) {
      return;
    }
    return await this.deserialize(state);
  }

  async getBatch(ids: string[]) {
    const db = await this.db();
    const states = await db
      .select(columns)
      .from(schema.resources)
      .where(
        and(
          inArray(schema.resources.id, ids),
          eq(schema.resources.scope, this.chain),
        ),
      );
    return await this.deserializeMany(states);
  }

  async all() {
    const db = await this.db();
    const states = await db
      .select(columns)
      .from(schema.resources)
      .where(eq(schema.resources.scope, this.chain));
    return await this.deserializeMany(states);
  }

  async set(_: string, state: State) {
    const serialized = await this.serialize(state);
    const db = await this.db();
    await db
      .insert(schema.resources)
      .values({
        ...serialized,
        scope: this.chain,
      })
      .onConflictDoUpdate({
        target: [schema.resources.id, schema.resources.scope],
        set: serialized,
      });
  }

  async delete(id: string) {
    const db = await this.db();
    await db
      .delete(schema.resources)
      .where(
        and(
          eq(schema.resources.id, id),
          eq(schema.resources.scope, this.chain),
        ),
      );
  }

  private async deserialize(
    state: Omit<schema.Resource, "scope">,
  ): Promise<State> {
    return await deserialize(this.scope, {
      ...state,
      oldProps: state.oldProps ?? undefined,
    });
  }

  private async serialize(state: State) {
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

export const resolveMigrationsPath = () => {
  return path.join(import.meta.dirname, "..", "..", "drizzle");
};
