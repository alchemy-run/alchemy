import type {
  StoredVector,
  VectorizeProps,
} from "./VectorizeOptions.shared.ts";

const encoder = new TextEncoder();
const scalar = (v: unknown): v is string | number | boolean | null =>
  v === null ||
  typeof v === "string" ||
  typeof v === "boolean" ||
  (typeof v === "number" && Number.isFinite(v));

export function validateConfig(props: VectorizeProps) {
  if (
    !Number.isInteger(props.dimensions) ||
    props.dimensions < 1 ||
    props.dimensions > 1536
  ) {
    throw new Error(
      "Vectorize dimensions must be an integer between 1 and 1536",
    );
  }
  if (
    !["cosine", "euclidean", "dot-product"].includes(props.metric ?? "cosine")
  ) {
    throw new Error("Invalid Vectorize distance metric");
  }
  if (Object.keys(props.metadataIndexes ?? {}).length > 10) {
    throw new Error("Vectorize supports at most 10 metadata indexes");
  }
}

export function validateValues(values: number[], dimensions: number) {
  if (
    !Array.isArray(values) ||
    values.length !== dimensions ||
    values.some(
      (v) => typeof v !== "number" || !Number.isFinite(Math.fround(v)),
    )
  ) {
    throw new Error(`Expected ${dimensions} finite vector dimensions`);
  }
}

function property(metadata: Record<string, unknown>, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (value, part) =>
        value !== null &&
        typeof value === "object" &&
        Object.hasOwn(value, part)
          ? (value as Record<string, unknown>)[part]
          : undefined,
      metadata,
    );
}

function truncate(value: string): string {
  let result = "";
  for (const character of value) {
    if (encoder.encode(result + character).length > 64) break;
    result += character;
  }
  return result;
}

export function prepareVector(
  vector: Omit<StoredVector, "indexed">,
  props: VectorizeProps,
): StoredVector {
  if (
    typeof vector.id !== "string" ||
    vector.id.length === 0 ||
    encoder.encode(vector.id).length > 64
  ) {
    throw new Error("Vector IDs must be between 1 and 64 bytes");
  }
  validateValues(vector.values, props.dimensions);
  if (
    vector.namespace !== undefined &&
    (typeof vector.namespace !== "string" ||
      encoder.encode(vector.namespace).length > 64)
  ) {
    throw new Error("Vector namespaces must be at most 64 bytes");
  }
  const metadata = vector.metadata;
  if (
    metadata !== undefined &&
    (metadata === null ||
      typeof metadata !== "object" ||
      Array.isArray(metadata) ||
      encoder.encode(JSON.stringify(metadata)).length > 10240)
  ) {
    throw new Error("Vector metadata must be an object of at most 10 KiB");
  }
  const indexed: StoredVector["indexed"] = {};
  for (const [name, type] of Object.entries(props.metadataIndexes ?? {})) {
    const value = property(metadata ?? {}, name);
    if (typeof value === type && scalar(value) && value !== null) {
      indexed[name] = typeof value === "string" ? truncate(value) : value;
    }
  }
  return {
    id: vector.id,
    values: vector.values.map(Math.fround),
    ...(vector.namespace !== undefined ? { namespace: vector.namespace } : {}),
    ...(metadata !== undefined ? { metadata: structuredClone(metadata) } : {}),
    indexed,
    indexedVersions: { ...props.metadataIndexVersions },
  };
}

export interface QueryOptions {
  vector?: number[];
  vectorId?: string;
  topK?: number;
  namespace?: string;
  returnValues?: boolean;
  returnMetadata?: "all" | "indexed" | "none" | boolean;
  filter?: Record<string, unknown>;
}

export function compileFilter(
  filter: QueryOptions["filter"],
  props: VectorizeProps,
): (v: StoredVector) => boolean {
  if (filter === undefined) return () => true;
  if (
    filter === null ||
    typeof filter !== "object" ||
    Array.isArray(filter) ||
    !Object.keys(filter).length ||
    encoder.encode(JSON.stringify(filter)).length >= 2048
  ) {
    throw new Error(
      "Vectorize filter must be a non-empty object smaller than 2048 bytes",
    );
  }
  const conditions = Object.entries(filter).map(([key, expression]) => {
    if (!Object.hasOwn(props.metadataIndexes ?? {}, key))
      throw new Error(`No metadata index for ${key}`);
    const operators: Record<string, unknown> = scalar(expression)
      ? { $eq: expression }
      : (expression as Record<string, unknown>);
    if (
      !operators ||
      typeof operators !== "object" ||
      Array.isArray(operators) ||
      !Object.keys(operators).length
    )
      throw new Error("Invalid filter expression");
    const keys = Object.keys(operators);
    if (
      keys.length > 1 &&
      !(
        keys.length === 2 &&
        keys.filter((k) => ["$lt", "$lte"].includes(k)).length === 1 &&
        keys.filter((k) => ["$gt", "$gte"].includes(k)).length === 1
      )
    )
      throw new Error("Only lower and upper range filters may be combined");
    const tests = Object.entries(operators).map(([operator, expected]) => {
      if (["$eq", "$ne"].includes(operator)) {
        if (!scalar(expected))
          throw new Error("Expected a scalar filter value");
        return (actual: unknown) =>
          operator === "$eq" ? actual === expected : actual !== expected;
      }
      if (["$in", "$nin"].includes(operator)) {
        if (!Array.isArray(expected) || !expected.every(scalar))
          throw new Error("Expected an array of scalar filter values");
        return (actual: unknown) =>
          operator === "$in"
            ? scalar(actual) && expected.includes(actual)
            : !scalar(actual) || !expected.includes(actual);
      }
      if (["$lt", "$lte", "$gt", "$gte"].includes(operator)) {
        if (
          typeof expected !== "string" &&
          !(typeof expected === "number" && Number.isFinite(expected))
        )
          throw new Error("Expected a string or number range value");
        return (actual: unknown) => {
          if (
            (typeof actual !== "string" && typeof actual !== "number") ||
            typeof actual !== typeof expected
          )
            return false;
          return operator === "$lt"
            ? actual < expected
            : operator === "$lte"
              ? actual <= expected
              : operator === "$gt"
                ? actual > expected
                : actual >= expected;
        };
      }
      throw new Error(`Unsupported Vectorize filter operator ${operator}`);
    });
    return (vector: StoredVector) =>
      tests.every((test) =>
        test(
          vector.indexedVersions?.[key] === props.metadataIndexVersions?.[key]
            ? (vector.indexed[key] ?? null)
            : null,
        ),
      );
  });
  return (vector) => conditions.every((condition) => condition(vector));
}

export function queryVectors(
  vectors: StoredVector[],
  options: QueryOptions,
  props: VectorizeProps,
) {
  const topK = options.topK ?? 5;
  const metadata = options.returnMetadata ?? "none";
  const maximum =
    options.returnValues || metadata === "all" || metadata === true
      ? 100
      : 1000;
  if (!Number.isInteger(topK) || topK < 1 || topK > maximum)
    throw new Error(`topK must be between 1 and ${maximum}`);
  if (![true, false, "all", "indexed", "none"].includes(metadata))
    throw new Error("Invalid returnMetadata");
  const vector =
    options.vector ?? vectors.find((v) => v.id === options.vectorId)?.values;
  if (!vector) throw new Error("Query vector ID was not found");
  validateValues(vector, props.dimensions);
  const matchesFilter = compileFilter(options.filter, props);
  const metric = props.metric ?? "cosine";
  const matches = vectors
    .filter(
      (v) =>
        (options.namespace === undefined ||
          v.namespace === options.namespace) &&
        matchesFilter(v),
    )
    .map((v) => {
      let dot = 0,
        normA = 0,
        normB = 0,
        distance = 0;
      for (let i = 0; i < vector.length; i++) {
        dot += vector[i]! * v.values[i]!;
        normA += vector[i]! ** 2;
        normB += v.values[i]! ** 2;
        distance += (vector[i]! - v.values[i]!) ** 2;
      }
      const score =
        metric === "euclidean"
          ? Math.sqrt(distance)
          : metric === "dot-product"
            ? dot
            : normA && normB
              ? dot / Math.sqrt(normA * normB)
              : 0;
      return {
        id: v.id,
        score,
        ...(v.namespace !== undefined ? { namespace: v.namespace } : {}),
        ...(options.returnValues ? { values: v.values } : {}),
        ...(metadata === "all" || metadata === true
          ? { metadata: v.metadata ?? {} }
          : metadata === "indexed"
            ? {
                metadata: Object.fromEntries(
                  Object.entries(v.indexed).filter(
                    ([key]) =>
                      Object.hasOwn(props.metadataIndexes ?? {}, key) &&
                      v.indexedVersions?.[key] ===
                        props.metadataIndexVersions?.[key],
                  ),
                ),
              }
            : {}),
      };
    })
    .sort(
      (a, b) =>
        (metric === "euclidean" ? a.score - b.score : b.score - a.score) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .slice(0, topK);
  return { count: matches.length, matches };
}
