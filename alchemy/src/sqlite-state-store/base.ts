import { and, eq, getTableColumns, inArray, notExists } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { Scope } from "../scope.ts";
import { deserialize, serialize } from "../serde.ts";
import type { State, StateStore } from "../state.ts";
import * as schema from "./internal/schema.ts";

type Database = BaseSQLiteDatabase<any, any, typeof schema>;

export interface SQLiteStateStoreOptions<T extends Database = Database> {
  create: () => Promise<T>;
}

const { scope: _, ...columns } = getTableColumns(schema.resources);

export class BaseSQLiteStateStore<T extends Database = Database>
  implements StateStore
{
  readonly _tag = "SQLiteStateStore";

  private create: () => Promise<T>;
  private dbPromise?: Promise<T>;

  constructor(
    private readonly scope: Scope,
    options: SQLiteStateStoreOptions<T>,
  ) {
    this.create = options.create;
  }

  private get chain() {
    return this.scope.chain;
  }

  private async createWithScope() {
    const db = await this.create();
    const parent = this.chain.length > 1 ? this.chain.slice(0, -1) : null;
    // Alchemy doesn't always initialize the app scope before creating the stage scope
    // so we create it here to avoid a foreign key constraint error.
    if (parent?.length === 1) {
      await db
        .insert(schema.scopes)
        .values({ chain: parent })
        .onConflictDoNothing();
    }
    await db
      .insert(schema.scopes)
      .values({ chain: this.chain, parent })
      .onConflictDoNothing();
    return db;
  }

  private async db() {
    this.dbPromise ??= this.createWithScope();
    return await this.dbPromise;
  }

  async init() {
    await this.db();
  }

  async deinit() {
    if (!this.dbPromise) {
      return;
    }
    const db = await this.dbPromise;
    await db.delete(schema.scopes).where(eq(schema.scopes.chain, this.chain));
    if (this.chain.length === 2) {
      // When deinitializing the stage scope, we also delete the app scope
      // if it has no other stages attached.
      const root = [this.chain[0]] as string[];
      await db
        .delete(schema.scopes)
        .where(
          and(
            eq(schema.scopes.chain, root),
            notExists(
              db
                .select()
                .from(schema.scopes)
                .where(eq(schema.scopes.parent, root)),
            ),
          ),
        );
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
