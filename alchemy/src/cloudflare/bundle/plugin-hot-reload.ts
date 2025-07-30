import type esbuild from "esbuild";
import assert from "node:assert";

export interface HotReloadPluginProps {
  onBuildStart?: () => void | Promise<void>;
}

export function createHotReloadPlugin(props?: HotReloadPluginProps): {
  plugin: esbuild.Plugin;
  iterator: AsyncIterable<esbuild.BuildResult>;
} {
  let _controller:
    | ReadableStreamDefaultController<esbuild.BuildResult>
    | undefined;
  const stream = new ReadableStream<esbuild.BuildResult>({
    start: (controller) => {
      _controller = controller;
    },
  });
  const plugin: esbuild.Plugin = {
    name: "alchemy-hot-reload",
    setup(build) {
      if (props?.onBuildStart) {
        build.onStart(props.onBuildStart);
      }
      build.onEnd(async (result) => {
        assert(_controller);
        _controller.enqueue(result);
      });
      build.onDispose(() => {
        _controller?.close();
      });
    },
  };
  return {
    plugin,
    iterator: (async function* () {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        yield value;
      }
    })(),
  };
}
