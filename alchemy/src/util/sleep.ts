/**
 * Pauses execution for a specified number of milliseconds.
 * @param ms The number of milliseconds to sleep.
 * @returns A promise that resolves after the specified time.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
