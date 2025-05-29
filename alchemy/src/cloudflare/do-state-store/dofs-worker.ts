/**
 * DOFS State Store Worker Script
 * 
 * This is the Cloudflare Worker script that gets auto-deployed
 * to provide the DOFS (Durable Object File System) functionality.
 */

export const DOFS_WORKER_SCRIPT = `
import { DurableObject } from "cloudflare:workers";
import { Fs } from "dofs";

/**
 * DOFS-powered state storage using the actual DOFS library
 */
export class AlchemyDOFSStateStore extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.fs = new Fs(state, env, {
      chunkSize: 256 * 1024, // 256KB recommended balance
    });
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      const operation = request.headers.get("X-Operation");
      
      console.log(\`Received request: \${request.method} \${url.pathname} with operation: \${operation}\`);
      
      if (!operation) {
        console.log("Missing X-Operation header");
        return new Response("Missing X-Operation header", { status: 400 });
      }

      let body = null;
      if (request.method !== "GET" && request.headers.get("content-type")?.includes("application/json")) {
        try {
          const text = await request.text();
          console.log(\`Request body: \${text}\`);
          body = text ? JSON.parse(text) : null;
        } catch (e) {
          console.log(\`Failed to parse request body: \${e}\`);
          return new Response("Invalid JSON in request body", { status: 400 });
        }
      }

      console.log(\`Processing operation: \${operation} with body:\`, body);

      switch (operation) {
        case "readFile":
          return await this.handleReadFile(request.headers.get("X-Path"));
          
        case "writeFile":
          return await this.handleWriteFile(body?.path, body?.data);
          
        case "listDir":
          return await this.handleListDir(request.headers.get("X-Path"));
          
        case "mkdir":
          return await this.handleMkdir(body?.path, body?.recursive);
          
        case "unlink":
          return await this.handleUnlink(body?.path);
          
        case "rmdir":
          return await this.handleRmdir(body?.path, body?.recursive);
          
        case "stat":
          return await this.handleStat(body?.path);
          
        default:
          console.log(\`Unknown operation: \${operation}\`);
          return new Response(\`Unknown operation: \${operation}\`, { status: 400 });
      }
    } catch (error) {
      console.error("DOFS State Store Error:", error);
      
      // Handle DOFS filesystem errors
      if (error.code === "ENOENT" || error.message.includes("not found")) {
        return new Response("File not found", { status: 404 });
      }
      if (error.code === "EEXIST") {
        return new Response("File exists", { status: 409 });
      }
      if (error.code === "ENOTDIR") {
        return new Response("Not a directory", { status: 400 });
      }
      if (error.code === "EISDIR") {
        return new Response("Is a directory", { status: 400 });
      }
      if (error.code === "ENOTEMPTY") {
        return new Response("Directory not empty", { status: 400 });
      }
      if (error.code === "ENOSPC") {
        return new Response("No space left", { status: 507 });
      }
      
      return new Response(\`Internal server error: \${error.message}\`, { status: 500 });
    }
  }

  async handleReadFile(path) {
    console.log(\`handleReadFile: \${path}\`);
    
    if (!path) {
      return new Response("Missing path parameter", { status: 400 });
    }
    
    try {
      const data = await this.fs.readFile(path, 'utf8');
      console.log(\`Read file result: \${data ? 'found' : 'not found'}\`);
      
      return new Response(data, {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.log(\`Read file error: \${error}\`);
      if (error.code === "ENOENT") {
        return new Response("File not found", { status: 404 });
      }
      throw error;
    }
  }

  async handleWriteFile(path, data) {
    console.log(\`handleWriteFile: \${path}, data length: \${data?.length || 0}\`);
    
    if (!path || data === undefined) {
      return new Response("Missing path or data parameter", { status: 400 });
    }
    
    try {
      // Ensure directory exists
      const dir = path.substring(0, path.lastIndexOf('/'));
      if (dir) {
        await this.fs.mkdir(dir, { recursive: true });
      }
      
      await this.fs.writeFile(path, data, 'utf8');
      console.log(\`Successfully wrote file: \${path}\`);
      return new Response("OK");
    } catch (error) {
      console.log(\`Write file error: \${error}\`);
      return new Response(\`Failed to write file: \${error.message}\`, { status: 500 });
    }
  }

  async handleListDir(path) {
    console.log(\`handleListDir: \${path}\`);
    
    if (!path) {
      return new Response("Missing path parameter", { status: 400 });
    }
    
    try {
      const entries = await this.fs.readdir(path);
      console.log(\`Found \${entries.length} entries in \${path}\`);
      
      // Filter for files (not directories) and return just the names
      const files = [];
      for (const entry of entries) {
        const fullPath = path + '/' + entry;
        try {
          const stat = await this.fs.stat(fullPath);
          if (stat.isFile()) {
            files.push(entry);
          }
        } catch (e) {
          // Skip entries we can't stat
          console.log(\`Skipping entry \${entry}: \${e.message}\`);
        }
      }
      
      console.log(\`Filtered files: \${JSON.stringify(files)}\`);
      
      return new Response(JSON.stringify(files), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.log(\`List dir error: \${error}\`);
      if (error.code === "ENOENT") {
        return new Response("Directory not found", { status: 404 });
      }
      return new Response(\`Failed to list directory: \${error.message}\`, { status: 500 });
    }
  }

  async handleMkdir(path, recursive) {
    console.log(\`handleMkdir: \${path}, recursive: \${recursive}\`);
    
    if (!path) {
      return new Response("Missing path parameter", { status: 400 });
    }
    
    try {
      await this.fs.mkdir(path, { recursive: Boolean(recursive) });
      console.log(\`Directory creation successful: \${path}\`);
      return new Response("OK");
    } catch (error) {
      console.log(\`Mkdir error: \${error}\`);
      if (error.code === "EEXIST") {
        return new Response("Directory exists", { status: 409 });
      }
      return new Response(\`Failed to create directory: \${error.message}\`, { status: 500 });
    }
  }

  async handleUnlink(path) {
    console.log(\`handleUnlink: \${path}\`);
    
    if (!path) {
      return new Response("Missing path parameter", { status: 400 });
    }
    
    try {
      await this.fs.unlink(path);
      console.log(\`Successfully deleted file: \${path}\`);
      return new Response("OK");
    } catch (error) {
      console.log(\`Unlink error: \${error}\`);
      if (error.code === "ENOENT") {
        return new Response("File not found", { status: 404 });
      }
      return new Response(\`Failed to delete file: \${error.message}\`, { status: 500 });
    }
  }

  async handleRmdir(path, recursive) {
    console.log(\`handleRmdir: \${path}, recursive: \${recursive}\`);
    
    if (!path) {
      return new Response("Missing path parameter", { status: 400 });
    }
    
    try {
      if (recursive) {
        await this.fs.rmdir(path, { recursive: true });
      } else {
        await this.fs.rmdir(path);
      }
      
      console.log(\`Successfully removed directory: \${path}\`);
      return new Response("OK");
    } catch (error) {
      console.log(\`Rmdir error: \${error}\`);
      if (error.code === "ENOENT") {
        return new Response("Directory not found", { status: 404 });
      }
      if (error.code === "ENOTEMPTY") {
        return new Response("Directory not empty", { status: 400 });
      }
      return new Response(\`Failed to remove directory: \${error.message}\`, { status: 500 });
    }
  }

  async handleStat(path) {
    console.log(\`handleStat: \${path}\`);
    
    if (!path) {
      return new Response("Missing path parameter", { status: 400 });
    }
    
    try {
      const stat = await this.fs.stat(path);
      
      const result = {
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        size: stat.size,
        mtime: stat.mtime,
        ctime: stat.ctime,
      };
      
      console.log(\`Stat result: \${JSON.stringify(result)}\`);
      
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.log(\`Stat error: \${error}\`);
      if (error.code === "ENOENT") {
        return new Response("File not found", { status: 404 });
      }
      return new Response(\`Stat failed: \${error.message}\`, { status: 500 });
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    console.log(\`Worker received request: \${request.method} \${request.url}\`);
    
    try {
      const durableObjectId = env.ALCHEMY_DOFS_STATE_STORE.idFromName("default");
      const durableObject = env.ALCHEMY_DOFS_STATE_STORE.get(durableObjectId);
      
      console.log(\`Forwarding to Durable Object...\`);
      const response = await durableObject.fetch(request);
      
      console.log(\`Durable Object response: \${response.status} \${response.statusText}\`);
      return response;
    } catch (error) {
      console.error(\`Worker error: \${error}\`);
      return new Response(\`Worker error: \${error.message}\`, { status: 500 });
    }
  }
};
`; 