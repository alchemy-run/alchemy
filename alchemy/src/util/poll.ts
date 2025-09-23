/**
 * Polls a function until it returns a result that satisfies the predicate.
 */
export async function poll<T>(input: {
  /**
   * A description of the operation being polled.
   */
  description: string;

  /**
   * The function to poll.
   */
  fn: () => Promise<T>;

  /**
   * A predicate that determines if the operation has completed.
   */
  predicate: (result: T) => boolean;

  /**
   * The initial delay between polls.
   * @default 250ms
   */
  initialDelay?: number;

  /**
   * The maximum delay between polls.
   * @default 2_500ms (2.5 seconds)
   */
  maxDelay?: number;

  /**
   * The timeout for the poll in milliseconds.
   * @default 1_000_000 (~16 minutes)
   */
  timeout?: number;
}): Promise<T> {
  const start = Date.now();
  let delay = input.initialDelay ?? 250;
  while (true) {
    const result = await input.fn();
    if (input.predicate(result)) {
      return result;
    }
    if (Date.now() - start >= (input.timeout ?? 1_000_000)) {
      throw new Error(
        `Timed out waiting for ${input.description} after ${Math.round(
          (input.timeout ?? 1_000_000) / 1000,
        )}s`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, input.maxDelay ?? 5_000);
  }
}
