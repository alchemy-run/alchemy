import { DurableObject } from "cloudflare:workers";
import { Fs } from "dofs";

/**
 * Durable Object that provides state storage using DOFS
 */
export class AlchemyDOFSStateStore extends DurableObject {
  private fs: Fs;

  constructor(state: DurableObjectState, env: any) {
    super(state, env);
    this.fs = new Fs(state, env, {
      chunkSize: 256 * 1024, // 256KB chunks for good performance
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const operation = request.headers.get("X-Operation");
      
      if (!operation) {
        return new Response("Missing X-Operation header", { status: 400 });
      }

      const body: any = request.method !== "GET" ? await request.json() : null;

      switch (operation) {
        case "readFile":
          return this.handleReadFile(body?.path);
          
        case "writeFile":
          return this.handleWriteFile(body?.path, body?.data);
          
        case "listDir":
          return this.handleListDir(body?.path);
          
        case "mkdir":
          return this.handleMkdir(body?.path, body?.recursive);
          
        case "unlink":
          return this.handleUnlink(body?.path);
          
        case "rmdir":
          return this.handleRmdir(body?.path, body?.recursive);
          
        case "stat":
          return this.handleStat(body?.path);
          
        default:
          return new Response(`Unknown operation: ${operation}`, { status: 400 });
      }
    } catch (error: any) {
      console.error("DOFS State Store Error:", error);
      
      // Handle DOFS-specific errors
      if (error.message === "ENOENT") {
        return new Response("File not found", { status: 404 });
      }
      if (error.message === "EEXIST") {
        return new Response("File already exists", { status: 409 });
      }
      if (error.message === "ENOTDIR") {
        return new Response("Not a directory", { status: 400 });
      }
      if (error.message === "EISDIR") {
        return new Response("Is a directory", { status: 400 });
      }
      if (error.message === "ENOTEMPTY") {
        return new Response("Directory not empty", { status: 400 });
      }
      if (error.message === "ENOSPC") {
        return new Response("No space left on device", { status: 507 });
      }
      
      return new Response(`Internal server error: ${error.message}`, { status: 500 });
    }
  }

  private async handleReadFile(path: string): Promise<Response> {
    if (!path) {
      return new Response("Missing path parameter", { status: 400 });
    }
    
    try {
      const stream = this.fs.readFile(path);
      return new Response(stream, {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error: any) {
      if (error.message === "ENOENT") {
        return new Response("File not found", { status: 404 });
      }
      throw error;
    }
  }

  private async handleWriteFile(path: string, data: string): Promise<Response> {
    if (!path || !data) {
      return new Response("Missing path or data parameter", { status: 400 });
    }
    
    // Ensure parent directory exists
    const parentPath = path.substring(0, path.lastIndexOf("/"));
    if (parentPath && parentPath !== "/") {
      try {
        this.fs.mkdir(parentPath, { recursive: true });
      } catch (error: any) {
        if (error.message !== "EEXIST") {
          throw error;
        }
      }
    }

    await this.fs.writeFile(path, data);
    return new Response("OK");
  }

  private handleListDir(path: string): Response {
    if (!path) {
      return new Response("Missing path parameter", { status: 400 });
    }
    
    try {
      const files = this.fs.listDir(path);
      return new Response(JSON.stringify(files), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error: any) {
      if (error.message === "ENOENT") {
        return new Response("Directory not found", { status: 404 });
      }
      throw error;
    }
  }

  private handleMkdir(path: string, recursive: boolean = false): Response {
    if (!path) {
      return new Response("Missing path parameter", { status: 400 });
    }
    
    try {
      this.fs.mkdir(path, { recursive });
      return new Response("OK");
    } catch (error: any) {
      if (error.message === "EEXIST") {
        return new Response("OK"); // Directory already exists, that's fine
      }
      throw error;
    }
  }

  private handleUnlink(path: string): Response {
    if (!path) {
      return new Response("Missing path parameter", { status: 400 });
    }
    
    try {
      this.fs.unlink(path);
      return new Response("OK");
    } catch (error: any) {
      if (error.message === "ENOENT") {
        return new Response("OK"); // File already doesn't exist, that's fine
      }
      throw error;
    }
  }

  private handleRmdir(path: string, recursive: boolean = false): Response {
    if (!path) {
      return new Response("Missing path parameter", { status: 400 });
    }
    
    try {
      this.fs.rmdir(path, { recursive });
      return new Response("OK");
    } catch (error: any) {
      if (error.message === "ENOENT") {
        return new Response("OK"); // Directory already doesn't exist, that's fine
      }
      throw error;
    }
  }

  private handleStat(path: string): Response {
    if (!path) {
      return new Response("Missing path parameter", { status: 400 });
    }
    
    try {
      const stat = this.fs.stat(path);
      return new Response(JSON.stringify(stat), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error: any) {
      if (error.message === "ENOENT") {
        return new Response("File not found", { status: 404 });
      }
      throw error;
    }
  }
}

/**
 * Worker entry point that routes requests to the appropriate Durable Object
 */
export default {
  async fetch(request: Request, env: any): Promise<Response> {
    try {
      const url = new URL(request.url);
      
      // Extract namespace from URL path or use default
      // URL format: /my-app/dev/resource-key or just /operation
      const pathParts = url.pathname.split("/").filter(Boolean);
      
      // Use the first part as the namespace, or "default" if none provided
      const namespace = pathParts.length > 0 ? pathParts[0] : "default";
      
      // Create a stable ID for this namespace
      const doId = env.ALCHEMY_DOFS_STATE_STORE.idFromName(namespace);
      const doStub = env.ALCHEMY_DOFS_STATE_STORE.get(doId);
      
      // Forward the request to the Durable Object
      return await doStub.fetch(request);
      
    } catch (error: any) {
      console.error("Worker error:", error);
      return new Response(`Worker error: ${error.message}`, { status: 500 });
    }
  },
}; 