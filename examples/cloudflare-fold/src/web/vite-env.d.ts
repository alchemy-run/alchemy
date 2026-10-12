/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The bank Api's origin, inlined at build time from the `BankApp` Worker's `env`. */
  readonly VITE_BANK_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
