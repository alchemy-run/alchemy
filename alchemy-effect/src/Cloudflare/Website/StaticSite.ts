import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Command, type CommandProps } from "../../Build/Command.ts";
import type { InputProps } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import { Worker, type WorkerProps } from "../Workers/Worker.ts";

export interface StaticSiteProps
  extends Omit<WorkerProps, "assets">, Omit<CommandProps, "env"> {
  dev?: {
    command: string;
  };
}

export const StaticSite = (id: string, props: InputProps<StaticSiteProps>) =>
  Effect.gen(function* () {
    // TODO(sam): local dev/hmr support?
    const build = yield* Command("Build", props);

    const worker = yield* Worker(
      "Worker",
      {
        ...props,
        assets: {
          ...build,
          path: build.outdir,
        },
      },
      // TODO(sam): do we want to add additional worker code or allow the user to provide their own?
      Effect.succeed(Effect.succeed(HttpServerResponse.empty({ status: 200 }))),
    );

    return worker;
  }).pipe(Namespace.push(id));
