import { createRequire } from "node:module";
import path from "node:path";
import type * as rolldown from "rolldown";

export const InternalWorkerImportPlugin = (
  options: {
    workersRoot: string;
  } = {
    workersRoot: "./workers",
  },
): Array<rolldown.Plugin> => {
  const WORKER_IMPORT_PREFIX = "\0worker-import:";
  const WORKER_SOURCE_PREFIX = "\0worker-source:";
  return [
    {
      name: "distilled:internal-worker-import",
      resolveId: {
        filter: { id: /^worker:.*$/ },
        async handler(id, importer) {
          const require = createRequire(importer ?? import.meta.url);
          const specifier = id.slice(7);
          const absolutePath = require.resolve(specifier);
          const relativePathTs = path.relative(
            path.resolve("./src"),
            absolutePath,
          );
          const relativePathMjs = relativePathTs.replace(/\.ts$/, ".mjs");
          return {
            id: `${WORKER_IMPORT_PREFIX}${relativePathMjs}`,
          };
        },
      },
      load: {
        // oxlint-disable-next-line no-control-regex
        filter: { id: new RegExp(`^${WORKER_IMPORT_PREFIX}`) },
        async handler(id) {
          const resolvedId = `${WORKER_SOURCE_PREFIX}${id.slice(WORKER_IMPORT_PREFIX.length)}`;
          return {
            code: `export const worker = () => import(${JSON.stringify(resolvedId)});`,
          };
        },
      },
    },
    {
      name: "distilled:internal-worker",
      resolveId: {
        filter: { id: new RegExp(`^${WORKER_SOURCE_PREFIX}`) },
        async handler(id) {
          const resolvedId = id.slice(WORKER_SOURCE_PREFIX.length);
          return {
            id: path.resolve(options.workersRoot, resolvedId),
            external: "relative",
          };
        },
      },
    },
  ];
};
