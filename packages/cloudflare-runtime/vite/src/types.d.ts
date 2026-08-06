declare module "worker:*" {
  export const worker: () => Promise<{
    main: string;
    modules: Record<string, string>;
  }>;
}
