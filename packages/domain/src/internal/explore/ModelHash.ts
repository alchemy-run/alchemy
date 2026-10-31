/**
 * `modelHash`: a stable hash of a model's definitions: member names, schemas,
 * command and event lists, and what each policy, view and projection reads.
 * It is structural: handler bodies (`decide`, `evolve`, policy code), actors
 * and layers are not in it. The digest of each trace step catches a change of
 * behaviour on replay. The hash
 * answers one question before any replay starts: is this the model the trace
 * was made on?
 */
import { canonical, digest, digestHex } from "./Canonical.ts";
import { EngineFault } from "./Errors.ts";

const SKIP = new Set(["~effect/Schema", "context", "annotations", "description", "documentation"]);
const KEPT_ANNOTATIONS = ["identifier", "title", "expected", "meta"];

/** A schema AST as plain data: functions drop out, annotations keep what names a type. */
const plain = (v: unknown, seen: Map<object, number>): unknown => {
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    return v;
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "symbol") return String(v);
  if (typeof v !== "object") return undefined;
  const known = seen.get(v);
  if (known !== undefined) return { ref: known };
  seen.set(v, seen.size);
  if (Array.isArray(v)) return v.map((x) => plain(x, seen) ?? null);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) {
    if (SKIP.has(k)) continue;
    const x = plain((v as Record<string, unknown>)[k], seen);
    if (x !== undefined) out[k] = x;
  }
  const notes = (v as { annotations?: Record<string, unknown> }).annotations;
  if (notes) {
    const kept = KEPT_ANNOTATIONS.filter((k) => notes[k] !== undefined).map((k) => [
      k,
      plain(notes[k], seen),
    ]);
    if (kept.length > 0) out.notes = Object.fromEntries(kept);
  }
  // A recursive schema: follow the thunk once (`seen` stops the cycle).
  const thunk = (v as { thunk?: unknown }).thunk;
  if (typeof thunk === "function") out.suspended = plain(thunk(), seen);
  return out;
};

const shape = (x: any): unknown => {
  if (x === undefined || x === null) return null;
  if (x.ast) return plain(x.ast, new Map());
  if (x.fields) return fields(x.fields);
  if (typeof x === "object") return fields(x);
  return String(x);
};

const fields = (f: Record<string, unknown>) =>
  Object.fromEntries(
    Object.keys(f)
      .sort()
      .map((k) => [k, shape(f[k])]),
  );

const nameOf = (x: any): string =>
  x?.aggregateName ??
  x?.viewName ??
  x?.policyName ??
  x?.projectionName ??
  x?.streamName ??
  x?.identifier ??
  x?.tag ??
  x?.name ??
  "?";

const names = (xs: unknown): Array<string> =>
  xs === undefined ? [] : (Array.isArray(xs) ? xs : [xs]).map(nameOf).sort();

const byName = <A>(xs: ReadonlyArray<A>, f: (x: A) => unknown) =>
  [...xs].map((x) => [nameOf(x), f(x)] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const message = (x: any) => ({ fields: x.fields ? fields(x.fields) : shape(x) });

const describe = (model: any) => {
  const d = model.definitions;
  return {
    aggregates: byName(d.aggregates, (a: any) => ({
      id: shape(a.definition.id),
      state: shape(a.definition.state),
      commands: byName(a.definition.commands, (c: any) => ({
        ...message(c),
        events: names(c.events),
        rejects: byName(c.rejects ?? [], message),
        reply: shape(c.reply),
      })),
      events: byName(a.definition.events ?? [], message),
    })),
    views: byName(d.views, (v: any) => ({
      from: names(v.definition.from),
      key: nameOf(v.definition.key),
      state: shape(v.definition.state),
    })),
    policies: byName(d.policies, (p: any) => ({
      from: names(p.definition.from),
      key: nameOf(p.definition.key),
      on: names(p.definition.on),
    })),
    projections: byName(d.projections, (p: any) => ({
      from: names(p.definition.from),
      key: nameOf(p.definition.key),
      on: names(p.definition.on),
    })),
    streams: names(d.streams),
    sagas: names(model.sagas),
    queries: names(model.queries),
  };
};

export const modelHashOf = (model: unknown): string =>
  digestHex(digest(canonical(describe(model))));

/** Refuse a trace or Story fixture made on another model. Never replays silently. */
export const assertModelHash = (
  model: unknown,
  expected: string | undefined,
  what = "this trace",
) => {
  const now = modelHashOf(model);
  if (expected === now) return;
  throw new EngineFault(
    "ModelChanged",
    `the model changed: ${what} was made on model hash ${expected ?? "(none)"}, this model has hash ${now}. Refusing to replay: run explore again on this model.`,
  );
};
