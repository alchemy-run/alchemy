/// <reference types="vite/client" />

// `moduleDetection: "force"` makes every file a module, so the augmentation
// has to be declared global explicitly to reach `import.meta.env`.
declare global {
  interface ImportMetaEnv {
    /**
     * The deployment this bundle belongs to, compiled in by
     * `@foldkit/vite-plugin` from its `buildId` option. Not optional: both
     * entries require one, and `vite.config.ts` guarantees a build has it.
     */
    readonly FOLDKIT_BUILD_ID: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

export {};
