import type {
  Miniflare as MiniflareInstance,
  SharedOptions,
  WorkerOptions,
} from "miniflare";
import fs from "node:fs";
import type { DevContext } from "../context.ts";
import { FileSystemStateStore } from "../fs/file-system-state-store.ts";
import { LocalOnlyResource, type Resource } from "../resource.ts";
import { MiniflareAiProxy } from "./miniflare-ai-proxy.ts";

export interface MiniflareProps {
  miniflareOptions?: Partial<SharedOptions>;
  workers?: Array<WorkerOptions>;
}

export interface Miniflare extends Resource<"cloudflare::Miniflare"> {
  miniflare: MiniflareInstance;
}

export const MiniflareWorkersSymbol = Symbol.for(
  "cloudflare::Miniflare::workers",
);
export const MiniflareInstanceSymbol = Symbol.for(
  "cloudflare::Miniflare::instance",
);

export const Miniflare = LocalOnlyResource(
  "cloudflare::Miniflare",
  {
    alwaysUpdate: true,
  },
  async function (
    this: DevContext<Miniflare>,
    id: string,
    props: MiniflareProps,
  ) {
    const storageRoute =
      this.scope.root.state instanceof FileSystemStateStore
        ? `${this.scope.root.state.dir}\\.miniflare`
        : undefined;

    if (this.phase === "delete") {
      if (storageRoute != null) {
        await fs.promises.rm(storageRoute, { recursive: true });
      }
      return this.destroy();
    }

    const workers = await this.scope.orchestrator.useFromLibrary(
      MiniflareWorkersSymbol,
      async () => {
        return (
          props?.workers ?? ([await MiniflareAiProxy()] as Array<WorkerOptions>)
        );
      },
    );
    const mf = await this.scope.orchestrator.useFromLibrary(
      MiniflareInstanceSymbol,
      async () => {
        const miniflare = await import("miniflare");
        const mf = new miniflare.Miniflare({
          // log: new Log(LogLevel.INFO),
          kvPersist: "./kv",
          r2Persist: "./r2",
          d1Persist: "./d1",
          durableObjectsPersist: "./do",
          secretsStorePersist: "./secrets",
          cache: true,
          cachePersist: "./cache",
          workers: workers,
          defaultPersistRoot: storageRoute,
          ...(props?.miniflareOptions ?? {}),
        });
        return mf;
      },
    );

    if (this.phase === "dev:start") {
      await mf.ready;
    }

    return this({
      // id,
      miniflare: mf,
    });
  },
);
