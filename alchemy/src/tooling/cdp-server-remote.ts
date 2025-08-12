import { spawn, type ChildProcess } from "node:child_process";
import path from "pathe";
import { detectRuntime } from "../util/detect-node-runtime.ts";
import { detectPackageManager } from "../util/detect-package-manager.ts";
import { logger } from "../util/logger.ts";

/**
 * Remote CDP server that runs in a separate process.
 * Maintains the same interface as CoreCDPServer but delegates to a worker process.
 * This prevents breakpoints in the main process from freezing the CDP server.
 */
export class CoreCDPServer {
  private worker?: ChildProcess;
  private requestId = 0;
  private pendingRequests = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: any) => void }
  >();
  private ready = false;
  private readyPromise: Promise<void>;

  constructor() {
    this.readyPromise = new Promise((resolve) => {
      this.startWorker().then(() => {
        const checkReady = () => {
          if (this.ready) {
            resolve();
          } else {
            setTimeout(checkReady, 10);
          }
        };
        checkReady();
      });
    });
  }
  private async startWorker() {
    const workerPath = path.join(import.meta.dirname, "cdp-server-worker.ts");

    // Detect package manager and runtime (copied from execute-alchemy.ts)
    const packageManager = await detectPackageManager(process.cwd());
    const runtime = detectRuntime();

    // Since we're always running TypeScript, determine the command
    let command: string[];

    switch (packageManager) {
      case "bun":
        command = ["bun", workerPath];
        break;
      case "deno":
        command = ["deno", "run", "-A", workerPath];
        break;
      case "pnpm":
        command = ["pnpm", "dlx", "tsx", workerPath];
        break;
      case "yarn":
        command = ["yarn", "tsx", workerPath];
        break;
      default:
        switch (runtime) {
          case "bun":
            command = ["bun", workerPath];
            break;
          case "deno":
            command = ["deno", "run", "-A", workerPath];
            break;
          case "node":
          default:
            command = ["npx", "tsx", workerPath];
            break;
        }
    }

    this.worker = spawn(command[0], command.slice(1), {
      stdio: ["pipe", "inherit", "inherit", "ipc"],
      env: process.env,
    });
    this.worker.on("message", (message: any) => {
      if (message.type === "ready") {
        this.ready = true;
        return;
      }

      const { id, result, error } = message;
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        if (error) {
          pending.reject(new Error(error.message));
        } else {
          pending.resolve(result);
        }
      }
    });

    this.worker.on("error", (error) => {
      logger.error("[debug] Worker process error:", error);
    });

    this.worker.on("exit", (code, signal) => {
      logger.warn(
        `[debug] Worker process exited with code ${code}, signal ${signal}`,
      );
      this.ready = false;
    });
  }

  private async sendRequest<T>(method: string, ...params: any[]): Promise<T> {
    await this.readyPromise;

    if (!this.worker) {
      throw new Error("CDP server worker is not running");
    }

    const id = (++this.requestId).toString();

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve,
        reject: reject,
      });

      this.worker!.send({ id, method, params });
    });
  }

  public registerRootCDP(wsUrl: string): void {
    // Fire and forget to maintain sync interface
    this.sendRequest("registerRootCDP", wsUrl).catch(console.error);
  }

  public async waitForRootCDP(): Promise<void> {
    return this.sendRequest("waitForRootCDP");
  }

  public async waitForDebugger(): Promise<void> {
    return this.sendRequest("waitForDebugger");
  }

  public close(): void {
    if (this.worker) {
      this.sendRequest("close").finally(() => {
        this.worker?.kill("SIGTERM");
        this.worker = undefined;
      });
    }
  }
}
