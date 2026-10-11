/** Whether Worker output is a placeholder without a physical script identity. */
export const isProvisionalWorkerOutput = (
  output: { workerId?: string; versionOf?: string; previewOf?: string } | undefined,
): boolean =>
  output?.workerId === "" && output.versionOf === undefined && output.previewOf === undefined;
