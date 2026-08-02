import { schema, table, t } from "spacetimedb/server";

const spacetimedb = schema({
  todo: table(
    { name: "todo", public: true },
    {
      id: t.u64().primaryKey().autoInc(),
      text: t.string(),
      done: t.bool(),
      attachmentKey: t.string().optional(),
      owner: t.identity(),
      createdAt: t.timestamp(),
    },
  ),

  // Transient activity feed: not persisted, broadcast to subscribers.
  activity: table(
    { name: "activity", public: true, event: true },
    {
      message: t.string(),
      at: t.timestamp(),
    },
  ),
});

export default spacetimedb;

export const add_todo = spacetimedb.reducer(
  { text: t.string(), attachmentKey: t.string().optional() },
  (ctx, { text, attachmentKey }) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new Error("todo text must not be empty");
    }
    const id = ctx.db.todo.id.find(0n) === null ? 1n : 0n;
    void id; // autoInc handled by SDK
    ctx.db.todo.insert({
      id: 0n,
      text: trimmed,
      done: false,
      attachmentKey: attachmentKey ?? undefined,
      owner: ctx.sender,
      createdAt: ctx.timestamp,
    });
    ctx.db.activity.insert({
      message: `added: ${trimmed}`,
      at: ctx.timestamp,
    });
  },
);

export const toggle_todo = spacetimedb.reducer(
  { id: t.u64() },
  (ctx, { id }) => {
    const row = ctx.db.todo.id.find(id);
    if (!row) throw new Error(`todo ${id} not found`);
    if (!row.owner.equals(ctx.sender)) throw new Error("forbidden");
    ctx.db.todo.id.update({ ...row, done: !row.done });
    ctx.db.activity.insert({
      message: `toggled ${id}`,
      at: ctx.timestamp,
    });
  },
);

export const remove_todo = spacetimedb.reducer(
  { id: t.u64() },
  (ctx, { id }) => {
    const row = ctx.db.todo.id.find(id);
    if (!row) throw new Error(`todo ${id} not found`);
    if (!row.owner.equals(ctx.sender)) throw new Error("forbidden");
    ctx.db.todo.id.delete(id);
    ctx.db.activity.insert({
      message: `removed ${id}`,
      at: ctx.timestamp,
    });
  },
);

export const set_attachment = spacetimedb.reducer(
  { id: t.u64(), attachmentKey: t.string() },
  (ctx, { id, attachmentKey }) => {
    const row = ctx.db.todo.id.find(id);
    if (!row) throw new Error(`todo ${id} not found`);
    if (!row.owner.equals(ctx.sender)) throw new Error("forbidden");
    ctx.db.todo.id.update({ ...row, attachmentKey });
    ctx.db.activity.insert({
      message: `attached ${attachmentKey}`,
      at: ctx.timestamp,
    });
  },
);

// Lifecycle: a connected client's first visible signal.
export const on_connect = spacetimedb.clientConnected((ctx) => {
  ctx.db.activity.insert({
    message: `client connected`,
    at: ctx.timestamp,
  });
});
