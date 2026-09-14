import {
  transformPipelineRecord,
  type LocalPipelinesProps,
} from "./PipelinesOptions.shared.ts";

type Env = { PROPS: LocalPipelinesProps } & Record<string, R2Bucket>;

export default function makeBinding(env: Env) {
  return {
    async send(records: Record<string, unknown>[]): Promise<void> {
      const props = env.PROPS;
      if (!props.enabled)
        throw new Error(
          "Local Pipelines Worker binding is disabled for this stream",
        );
      if (!Array.isArray(records))
        throw new TypeError("Pipeline.send expects an array of JSON records");
      if (!props.routes.length && records.length)
        throw new Error(
          "Local Pipelines has no active SQL pipeline/sink for this stream; events were not ingested",
        );
      const json = JSON.stringify(records);
      if (new TextEncoder().encode(json).byteLength > 5_000_000)
        throw new Error("Pipeline ingestion request exceeds 5 MB");
      const input: Record<string, unknown>[] = JSON.parse(json);
      const normalized = input.map((record) => {
        if (!record || typeof record !== "object" || Array.isArray(record))
          throw new TypeError("Pipeline records must be JSON objects");
        if (!props.fields?.length) return record;
        return Object.fromEntries(
          props.fields.map((field) => {
            const value = record[field.name];
            if (value == null) {
              if (field.required)
                throw new TypeError(
                  `Missing required pipeline field: ${field.name}`,
                );
              return [field.sqlName ?? field.name, null];
            }
            const valid =
              field.type === "json" ||
              (field.type === "string" && typeof value === "string") ||
              (field.type === "bool" && typeof value === "boolean") ||
              ((field.type === "int32" || field.type === "int64") &&
                typeof value === "number" &&
                Number.isSafeInteger(value) &&
                (field.type !== "int32" ||
                  (value >= -2147483648 && value <= 2147483647))) ||
              ((field.type === "float32" || field.type === "float64") &&
                typeof value === "number" &&
                Number.isFinite(value));
            if (!valid)
              throw new TypeError(
                `Invalid ${field.type} pipeline field: ${field.name}`,
              );
            return [field.sqlName ?? field.name, value];
          }),
        );
      });
      // Validate/transform the entire batch before any sink writes.
      const outputs = props.routes.map((route, index) => ({
        route,
        index,
        rows: normalized
          .map((record) => transformPipelineRecord(record, route.query))
          .filter((row) => row !== undefined),
      }));
      for (const { route, index, rows } of outputs) {
        if (!rows.length) continue;
        const date = new Date();
        const tokens: Record<string, string> = {
          Y: String(date.getUTCFullYear()),
          m: String(date.getUTCMonth() + 1).padStart(2, "0"),
          d: String(date.getUTCDate()).padStart(2, "0"),
          H: String(date.getUTCHours()).padStart(2, "0"),
          M: String(date.getUTCMinutes()).padStart(2, "0"),
          S: String(date.getUTCSeconds()).padStart(2, "0"),
          "%": "%",
        };
        const partition =
          route.timePattern?.replace(
            /%([YmdHMS%])/g,
            (_, token: string) => tokens[token]!,
          ) ?? "";
        const random = crypto.randomUUID();
        const timestamp = date.getTime().toString(16).padStart(12, "0");
        const id = `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${random.slice(15, 18)}-${random.slice(19)}`;
        const extension = route.compression === "gzip" ? ".json.gz" : ".json";
        const filename = `${route.filePrefix ?? ""}${id}${route.fileSuffix ?? extension}`;
        const key = [
          route.path?.replace(/^\/+|\/+$/g, ""),
          partition.replace(/^\/+|\/+$/g, ""),
          filename,
        ]
          .filter(Boolean)
          .join("/");
        const body = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
        const bytes =
          route.compression === "gzip"
            ? await new Response(
                new Blob([body])
                  .stream()
                  .pipeThrough(new CompressionStream("gzip")),
              ).arrayBuffer()
            : body;
        await env[`SINK_${index}`]!.put(key, bytes, {
          httpMetadata: {
            contentType: "application/x-ndjson",
            ...(route.compression === "gzip"
              ? { contentEncoding: "gzip" }
              : {}),
          },
        });
      }
    },
  };
}
