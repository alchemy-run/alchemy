import type esbuild from "esbuild";

export interface HotReloadPluginProps {
  onBuildStart?: () => void | Promise<void>;
  onBuildEnd?: (files: esbuild.OutputFile[]) => void | Promise<void>;
  onBuildError?: (errors: esbuild.Message[]) => void | Promise<void>;
}

export function esbuildPluginHotReload(
  props: HotReloadPluginProps,
): esbuild.Plugin {
  return {
    name: "alchemy-hot-reload",
    setup(build) {
      build.onStart(props.onBuildStart ?? (() => {}));
      build.onEnd(async (result) => {
        if (result.errors.length > 0) {
          await props.onBuildError?.(result.errors);
          return;
        }
      });
      build.onEnd(async (result) => {
        if (result.outputFiles && result.outputFiles.length > 0) {
          await props.onBuildEnd?.(result.outputFiles);
        }
      });
    },
  };
}
