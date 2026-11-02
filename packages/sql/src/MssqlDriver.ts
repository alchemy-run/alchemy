/**
 * Lazily load the `mssql` driver (an optional peer dependency of alchemy) with
 * a descriptive failure when it isn't installed. CJS/ESM interop is normalized
 * — callers always get the module's named surface.
 */
export const importMssql = (): Promise<typeof import("mssql")> =>
  import("mssql")
    .then((mod) =>
      (mod as { default?: { ConnectionPool?: unknown } }).default?.ConnectionPool !== undefined
        ? (mod as unknown as { default: typeof import("mssql") }).default
        : mod,
    )
    .catch((cause) => {
      throw new Error(
        "Failed to load the 'mssql' driver. Install the optional peer dependency 'mssql' to connect to SQL Server.",
        { cause },
      );
    });
