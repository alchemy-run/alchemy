/** Whether Worker output is a placeholder without a physical script identity. */
export const isProvisionalWorkerOutput = (
  output: { workerId?: string; versionOf?: string; previewOf?: string } | undefined,
): boolean =>
  output?.workerId === "" && output.versionOf === undefined && output.previewOf === undefined;

/** Account recorded for a Worker attempt, including legacy attribute snapshots. */
export const recordedWorkerAccount = (state: {
  workerAccountId?: string;
  attr?: { accountId?: string };
}): string | undefined => state.workerAccountId ?? state.attr?.accountId;
