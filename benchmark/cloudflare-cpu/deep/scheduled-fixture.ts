/** Future wall clock is only a scheduler input; never used to measure CPU. */
export const scheduledNow = 4_102_444_800_000; // 2100-01-01T00:00:00.000Z
export const scheduledRepeatMs = 86_400_000;
export const scheduledPayload = "x".repeat(64);
export const scheduledId = (index: number) => `event-${String(index).padStart(4, "0")}`;
export const scheduledExpected = (count: number) => ({
  count,
  checksum: (count * (count + 1)) / 2,
  orderedChecksum: (count * (count + 1) * (2 * count + 1)) / 6,
  payloadChecksum: count * 64 + (count * (count - 1)) / 2,
  payloadBytes: 64,
  remaining: count / 2,
  now: scheduledNow,
  repeatMs: scheduledRepeatMs,
  nextAlarm: scheduledNow + scheduledRepeatMs,
});
