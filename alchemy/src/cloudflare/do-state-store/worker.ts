import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { Fs } from "dofs";
import { timingSafeEqual } from "node:crypto";
import type { State } from "../../state.ts";
import type { DOStateStoreAPI } from "./types.ts";

interface Env {
  DOFS_STATE_STORE: DurableObjectNamespace<DOFSStateStore>;
  DOFS_TOKEN: string;
}

export default class extends WorkerEntrypoint<Env> {
  override async fetch(request: Request) {
    try {
      const result = await this.handle(request);
      const body: DOStateStoreAPI.Response = {
        success: true,
        status: 200,
        result: result ?? undefined,
      };
      return Response.json(body, { status: body.status });
    } catch (error) {
      return APIError.fromUnknown(error).toResponse();
    }
  }

  private async handle(request: Request) {
    if (!this.authorize(request)) {
      throw new APIError("Unauthorized", 401);
    }
    const stub = this.getStub(request);
    const body = await this.parseBody(request);
    switch (body.method) {
      case "validate":
        return null;
      case "all":
        return await stub.all(body.params.prefix);
      case "count":
        return await stub.count(body.params.prefix);
      case "delete":
        return await stub.delete(body.params.key);
      case "get":
        return await stub.get(body.params.key);
      case "getBatch":
        return await stub.getBatch(body.params.keys);
      case "list":
        return await stub.list(body.params.prefix);
      case "set":
        return await stub.set(body.params.key, body.params.value);
      default: {
        const _: never = body;
        throw new APIError("Method not found", 404);
      }
    }
  }

  private authorize(request: Request): boolean {
    const token = request.headers.get("Authorization")?.split(" ")[1];
    if (!token) {
      return false;
    }
    return timingSafeEqual(
      new TextEncoder().encode(token),
      new TextEncoder().encode(this.env.DOFS_TOKEN),
    );
  }

  private getStub(request: Request): DurableObjectStub<DOFSStateStore> {
    const url = new URL(request.url);
    const app = url.searchParams.get("app");
    const stage = url.searchParams.get("stage");
    if (!app || !stage) {
      throw new APIError("Missing app or stage", 400);
    }
    return this.env.DOFS_STATE_STORE.get(
      this.env.DOFS_STATE_STORE.idFromName(`${app}/${stage}`),
    );
  }

  private async parseBody(request: Request): Promise<DOStateStoreAPI.Request> {
    try {
      return await request.json<DOStateStoreAPI.Request>();
    } catch {
      throw new APIError("Invalid JSON", 400);
    }
  }
}

class APIError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }

  toResponse(): Response {
    return Response.json(
      {
        success: false,
        status: this.status,
        error: this.message,
      },
      { status: this.status },
    );
  }

  static fromUnknown(error: unknown): APIError {
    if (error instanceof APIError) {
      return error;
    }
    if (error instanceof Error) {
      return new APIError(error.message, 500);
    }
    return new APIError("An unknown error occurred.", 500);
  }
}

export class DOFSStateStore extends DurableObject<Env> {
  fs = new Fs(this.ctx, this.env, {
    chunkSize: 256 * 1024,
  });

  async all(prefix: string): Promise<Record<string, string>> {
    const keys = this.list(prefix);
    return await this.getBatch(keys);
  }

  count(prefix: string): number {
    return this.list(prefix).length;
  }

  delete(key: string): void {
    try {
      this.fs.unlink(key);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
  }

  async get(key: string): Promise<string | undefined> {
    try {
      const file = this.fs.readFile(key);
      return new Response(file).text();
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    }
  }

  async getBatch(keys: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    await Promise.all(
      keys.map(async (key) => {
        const value = await this.get(key);
        if (value) {
          result[key] = value;
        }
      }),
    );
    return result;
  }

  list(prefix: string): string[] {
    try {
      return this.fs
        .listDir(prefix, { recursive: true })
        .filter((item) => item !== "." && item !== "..");
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    }
  }

  async set(key: string, value: State): Promise<void> {
    this.ensureDir(key);
    await this.fs.writeFile(key, JSON.stringify(value));
  }

  private ensureDir(path: string): void {
    const dir = path.split("/").slice(0, -1).join("/");
    try {
      this.fs.mkdir(dir, { recursive: true });
    } catch {
      // directory already exists, ignore
    }
  }
}

const isErrorCode = (error: unknown, code: string) => {
  return error instanceof Error && "message" in error && error.message === code;
};
