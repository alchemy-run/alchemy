import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { deepEqual } from "../../Diff.ts";
import { isPlainObject } from "../../Util/data.ts";
import { sha256Object } from "../../Util/sha256.ts";

/**
 * Strategic-merge list keys. The first tuple whose keys all resolve wins.
 * `ports` is `containerPort`+`protocol` on containers and `port`+`protocol`
 * on Services. Tolerations match the whole tuple: `key` alone collides
 * (Exists vs Equal). Anything not listed is atomic: Kubernetes' default
 * list type. Order and length count, including a `name` field on a CRD list.
 *
 * `initContainers` is the exception that keeps document order. The name
 * still identifies an item, and the sequence is the execution order.
 * `finalizers` is a set of strings: controllers append their own, and order
 * is not significant.
 */
const listKeys: Record<string, readonly (readonly string[])[]> = {
  containers: [["name"]],
  initContainers: [["name"]],
  ephemeralContainers: [["name"]],
  volumes: [["name"]],
  env: [["name"]],
  imagePullSecrets: [["name"]],
  volumeMounts: [["mountPath"]],
  volumeDevices: [["devicePath"]],
  ports: [
    ["containerPort", "protocol"],
    ["port", "protocol"],
  ],
  readinessGates: [["conditionType"]],
  tolerations: [["key", "operator", "value", "effect"]],
};

/** Absent apiserver defaults, so a declared `{ key }` matches `{ key, operator: Equal }`. */
const listDefaults: Record<string, Record<string, string>> = {
  tolerations: { operator: "Equal", value: "", effect: "" },
  ports: { protocol: "TCP" },
};

/** Scalar merge sets. Identity is the string itself. */
const scalarSets = new Set(["finalizers"]);

/**
 * Maps whose values are Kubernetes quantities. The apiserver rewrites
 * `"0.1"` to `"100m"` and `"1.5Gi"` to `"1536Mi"`. Keying this off the
 * value's own name would also rewrite ConfigMap `data.memory`.
 */
const quantityParents = new Set(["requests", "limits", "hard"]);

const decimalNanos: Record<string, bigint> = {
  n: 1n,
  u: 1_000n,
  m: 1_000_000n,
  "": 1_000_000_000n,
  k: 1_000_000_000_000n,
  M: 1_000_000_000_000_000n,
  G: 1_000_000_000_000_000_000n,
  T: 1_000_000_000_000_000_000_000n,
  P: 1_000_000_000_000_000_000_000_000n,
  E: 1_000_000_000_000_000_000_000_000_000n,
};

const binaryFactor: Record<string, bigint> = {
  Ki: 1024n,
  Mi: 1024n ** 2n,
  Gi: 1024n ** 3n,
  Ti: 1024n ** 4n,
  Pi: 1024n ** 5n,
  Ei: 1024n ** 6n,
};

const quantityPattern = /^([+-])?(\d+)(?:\.(\d+))?(n|u|m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/;

/** Nanounits, or undefined when `raw` is not a Kubernetes quantity. */
const parseQuantityNanos = (raw: string): bigint | undefined => {
  const match = quantityPattern.exec(raw);
  if (!match) return undefined;
  const suffix = match[4] ?? "";
  const scale =
    suffix in binaryFactor ? binaryFactor[suffix]! * 1_000_000_000n : decimalNanos[suffix];
  if (scale === undefined) return undefined;
  const fraction = match[3] ?? "";
  const numerator = BigInt((match[2] ?? "") + fraction) * scale;
  const denominator = 10n ** BigInt(fraction.length);
  if (denominator === 0n || numerator % denominator !== 0n) return undefined;
  const magnitude = numerator / denominator;
  return match[1] === "-" ? -magnitude : magnitude;
};

const canonicalScalar = (
  parent: string | undefined,
  field: string | undefined,
  value: unknown,
): unknown => {
  if (parent === "ports" && field === "protocol" && typeof value === "string") {
    return value.toUpperCase();
  }
  if (typeof value === "string" && parent !== undefined && quantityParents.has(parent)) {
    const nanos = parseQuantityNanos(value);
    if (nanos !== undefined) return nanos.toString();
  }
  return value;
};

/**
 * `stringData` is write-only. The apiserver stores it as base64 `data` and
 * omits `stringData` from GET and apply responses, so compare the declared
 * strings with `data` decoded on both sides.
 */
const decodeSecretData = (data: unknown): Record<string, unknown> => {
  if (!isPlainObject(data)) return {};
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    decoded[key] =
      typeof value === "string" ? Buffer.from(value, "base64").toString("utf8") : value;
  }
  return decoded;
};

/** Root-only: Secret `stringData` is compared as decoded `data`. */
const normalizeApplied = (applied: unknown, desired: unknown): unknown => {
  if (!isPlainObject(applied) || !isPlainObject(desired)) return applied;
  if (
    (applied.kind === "Secret" || desired.kind === "Secret") &&
    "stringData" in desired &&
    isPlainObject(applied.data)
  ) {
    return { ...applied, stringData: decodeSecretData(applied.data) };
  }
  return applied;
};

const fieldValue = (
  item: unknown,
  key: string,
  field: string | undefined,
): string | number | undefined => {
  if (isPlainObject(item)) {
    const value = item[key];
    if (typeof value === "string") return key === "protocol" ? value.toUpperCase() : value;
    if (typeof value === "number") return value;
  }
  return field === undefined ? undefined : listDefaults[field]?.[key];
};

const alignKeys = (
  field: string | undefined,
  desired: ReadonlyArray<unknown>,
): readonly string[] | undefined => {
  for (const keys of (field === undefined ? undefined : listKeys[field]) ?? []) {
    if (desired.every((item) => keys.every((key) => fieldValue(item, key, field) !== undefined))) {
      return keys;
    }
  }
  return undefined;
};

const mergeKey = (item: unknown, keys: readonly string[], field: string | undefined): string =>
  keys.map((key) => String(fieldValue(item, key, field))).join("\0");

const scalarIdentity = (item: unknown): string | undefined => {
  const value = Redacted.isRedacted(item) ? Redacted.value(item) : item;
  return typeof value === "string" ? value : undefined;
};

/**
 * Fields alchemy applied. Leaf `null` is a scalar slot filled from the
 * document. Merge-key scalars stay so list identity still matches.
 * Persisted instead of the document so a Secret value is not copied into state.
 */
export const driftMask = (declaration: unknown): unknown => maskOf(declaration);

const maskOf = (declaration: unknown, field?: string, keep?: ReadonlySet<string>): unknown => {
  if (Redacted.isRedacted(declaration)) return maskOf(Redacted.value(declaration), field, keep);
  if (Array.isArray(declaration)) {
    if (field !== undefined && scalarSets.has(field)) {
      return declaration.map((item) => scalarIdentity(item) ?? null);
    }
    const keys = alignKeys(field, declaration);
    const keepKeys = keys === undefined ? undefined : new Set(keys);
    return declaration.map((item) => maskOf(item, undefined, keepKeys));
  }
  if (!isPlainObject(declaration)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(declaration)) {
    const value = Redacted.isRedacted(child) ? Redacted.value(child) : child;
    const leaf = !isPlainObject(value) && !Array.isArray(value);
    out[key] = keep?.has(key) && leaf ? value : maskOf(child, key);
  }
  return out;
};

/**
 * Declared paths, values taken from `document` (the apply response or a later
 * GET). Undeclared keys — HPA replicas, controller annotations, apiserver
 * defaults — are absent. `initContainers` keep the document's order.
 */
const selectDeclared = (
  declaration: unknown,
  document: unknown,
  field: string | undefined,
  parent?: string,
): unknown => {
  if (Redacted.isRedacted(declaration)) {
    return selectDeclared(Redacted.value(declaration), document, field, parent);
  }
  if (Redacted.isRedacted(document)) {
    return selectDeclared(declaration, Redacted.value(document), field, parent);
  }
  if (Array.isArray(declaration)) {
    const items = Array.isArray(document) ? document : [];
    if (field !== undefined && scalarSets.has(field)) {
      const present = new Set(items.map(scalarIdentity).filter((value) => value !== undefined));
      return declaration
        .map(scalarIdentity)
        .filter((value): value is string => value !== undefined && present.has(value))
        .sort((left, right) => left.localeCompare(right));
    }
    const keys = alignKeys(field, declaration);
    if (keys === undefined) {
      const length = Math.max(declaration.length, items.length);
      return Array.from({ length }, (_, index) =>
        index < declaration.length
          ? selectDeclared(declaration[index], items[index], field)
          : items[index],
      );
    }
    const match = (item: unknown) =>
      items.find((candidate) =>
        keys.every((key) => fieldValue(candidate, key, field) === fieldValue(item, key, field)),
      );
    if (field === "initContainers") {
      const declaredByKey = new Map(declaration.map((item) => [mergeKey(item, keys, field), item]));
      const seen = new Set<string>();
      const ordered: unknown[] = [];
      for (const item of items) {
        const key = mergeKey(item, keys, field);
        const declaredItem = declaredByKey.get(key);
        if (declaredItem === undefined || seen.has(key)) continue;
        seen.add(key);
        ordered.push(selectDeclared(declaredItem, item, field));
      }
      for (const item of declaration) {
        const key = mergeKey(item, keys, field);
        if (!seen.has(key)) ordered.push(selectDeclared(item, undefined, field));
      }
      return ordered;
    }
    return declaration
      .map((item) => ({
        key: mergeKey(item, keys, field),
        value: selectDeclared(item, match(item), field),
      }))
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((entry) => entry.value);
  }
  if (!isPlainObject(declaration)) return canonicalScalar(parent, field, document);
  const source = isPlainObject(document) ? document : {};
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(declaration)) {
    out[key] = selectDeclared(child, source[key], key, field);
  }
  return out;
};

/** Selection of `document` through `declaration` (or a {@link driftMask}). */
export const selectDrift = (declaration: unknown, document: unknown): unknown =>
  selectDeclared(declaration, normalizeApplied(document, declaration), undefined);

/** True when a live object and a baseline agree on the declared fields. */
export const appliedObjectsMatch = (live: unknown, preview: unknown, desired: unknown): boolean =>
  deepEqual(selectDrift(desired, live), selectDrift(desired, preview));

/** Hash of {@link selectDrift}. The apply response and a later GET share it. */
export const hashDriftSelection = (declaration: unknown, document: unknown) =>
  Effect.sync(() => {
    const viewed = selectDrift(declaration, document);
    return isPlainObject(viewed) ? viewed : { value: viewed };
  }).pipe(Effect.flatMap(sha256Object));
