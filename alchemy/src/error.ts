export async function ignore<T>(
  codes: string | string[],
  fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error: any) {
    const errorCode = error.code || error.name;
    if (
      Array.isArray(codes) ? codes.includes(errorCode) : errorCode === codes
    ) {
      return undefined;
    }
    throw error;
  }
}
