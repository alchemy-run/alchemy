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

const identityContainerSurvivesPersistence = (raw: unknown, stored: unknown): boolean =>
  raw == null
    ? stored == null
    : typeof raw === "object" &&
      typeof stored === "object" &&
      stored !== null &&
      [Object.prototype, null].includes(Object.getPrototypeOf(raw)) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(stored));

const identitySurvivesPersistence = (raw: unknown, stored: unknown, key?: string): boolean => {
  if (raw == null) return stored == null;
  if (typeof raw === "string") return raw.length > 0 && raw === stored;
  if (
    key === undefined ||
    typeof raw !== "object" ||
    typeof stored !== "object" ||
    raw === null ||
    stored === null ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(stored))
  )
    return false;
  const identity = (raw as Record<string, unknown>)[key];
  return (
    typeof identity === "string" &&
    identity.length > 0 &&
    (stored as Record<string, unknown>)[key] === identity
  );
};

/** Whether serialization preserves every Worker physical identity property. */
export const workerIdentitySurvivesPersistence = (
  raw: Record<string, any> | undefined,
  stored: Record<string, any> | undefined,
): boolean =>
  identityContainerSurvivesPersistence(raw, stored) &&
  identityContainerSurvivesPersistence(raw?.version, stored?.version) &&
  identityContainerSurvivesPersistence(raw?.preview, stored?.preview) &&
  identitySurvivesPersistence(raw?.name, stored?.name) &&
  identitySurvivesPersistence(raw?.namespace, stored?.namespace, "name") &&
  identitySurvivesPersistence(raw?.version?.parent, stored?.version?.parent, "workerName") &&
  identitySurvivesPersistence(raw?.preview?.of, stored?.preview?.of, "workerId");

/** Whether two complete Worker prop sets identify the same physical attempt. */
export const sameWorkerIdentity = (
  left: Record<string, any>,
  right: Record<string, any>,
): boolean => {
  if (
    !workerIdentitySurvivesPersistence(left, left) ||
    !workerIdentitySurvivesPersistence(right, right)
  )
    return false;
  const namespace = (props: Record<string, any>) =>
    typeof props.namespace === "string" ? props.namespace : props.namespace?.name;
  const parent = (props: Record<string, any>) =>
    typeof props.version?.parent === "string"
      ? props.version.parent
      : props.version?.parent?.workerName;
  const preview = (props: Record<string, any>) =>
    typeof props.preview?.of === "string" ? props.preview.of : props.preview?.of?.workerId;
  return (
    left.name === right.name &&
    namespace(left) === namespace(right) &&
    parent(left) === parent(right) &&
    preview(left) === preview(right)
  );
};
