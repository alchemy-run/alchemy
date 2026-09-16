import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  prepareVector,
  queryVectors,
  validateConfig,
  type QueryOptions,
} from "./VectorizeIndex.shared.ts";
import type {
  StoredVector,
  VectorizeProps,
} from "./VectorizeOptions.shared.ts";

interface Env {
  OBJECT: DurableObjectNamespace<VectorizeObject>;
}

export default class extends WorkerEntrypoint<Env, VectorizeProps> {
  async fetch(request: Request) {
    const props = this.ctx.props;
    const headers = new Headers(request.headers);
    headers.set("X-Vectorize-Props", JSON.stringify(props));
    return this.env.OBJECT.get(
      this.env.OBJECT.idFromName(props.indexName),
    ).fetch(new Request(request, { headers }));
  }
}

export class VectorizeObject extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    try {
      const props: VectorizeProps = JSON.parse(
        request.headers.get("X-Vectorize-Props")!,
      );
      validateConfig(props);
      const operation = new URL(request.url).pathname.slice(1);
      const text = request.method === "GET" ? "" : await request.text();
      const body =
        text && !request.headers.get("content-type")?.includes("ndjson")
          ? JSON.parse(text)
          : undefined;
      const prepared =
        operation === "insert" || operation === "upsert"
          ? ((request.headers.get("content-type")?.includes("ndjson")
              ? text
                  .trim()
                  .split("\n")
                  .filter(Boolean)
                  .map((line) => JSON.parse(line))
              : body.vectors
            ).map((v: StoredVector) =>
              prepareVector(v, props),
            ) as StoredVector[])
          : undefined;
      // One transaction makes concurrent insert/upsert/delete atomic and avoids
      // the lost updates of a read-modify-write KV implementation.
      return await this.ctx.storage.transaction(async (storage) => {
        const configuration = {
          dimensions: props.dimensions,
          metric: props.metric ?? "cosine",
        };
        const previous =
          await storage.get<typeof configuration>("configuration");
        if (
          previous &&
          (previous.dimensions !== configuration.dimensions ||
            previous.metric !== configuration.metric)
        )
          throw new Error(
            "Local Vectorize index already exists with different dimensions or metric",
          );
        if (!previous) await storage.put("configuration", configuration);
        const entries = await storage.list<StoredVector>({ prefix: "vector:" });
        const vectors = [...entries.values()];
        if (operation === "info")
          return Response.json({
            dimensions: props.dimensions,
            vectorCount: vectors.length,
            ...((await storage.get("mutation")) ?? {}),
          });
        if (operation === "query")
          return Response.json(
            queryVectors(vectors, body as QueryOptions, props),
          );
        if (operation === "getByIds") {
          const { ids } = body as { ids: string[] };
          return Response.json(
            ids.flatMap((id) => {
              const v = entries.get(`vector:${id}`);
              if (!v) return [];
              const { indexed: _, indexedVersions: __, ...result } = v;
              return [result];
            }),
          );
        }
        if (operation === "insert" || operation === "upsert") {
          for (const v of prepared!) {
            const key = `vector:${v.id}`;
            if (operation === "upsert" || !entries.has(key)) {
              await storage.put(key, v);
              entries.set(key, v);
            }
          }
        } else if (operation === "deleteByIds") {
          const { ids } = body as { ids: string[] };
          await storage.delete(ids.map((id) => `vector:${id}`));
        } else
          return Response.json(
            { error: "Unknown Vectorize operation" },
            { status: 404 },
          );
        const mutationId = crypto.randomUUID();
        await storage.put("mutation", {
          processedUpToMutation: mutationId,
          processedUpToDatetime: new Date().toISOString(),
        });
        return Response.json({ mutationId });
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }
  }
}
