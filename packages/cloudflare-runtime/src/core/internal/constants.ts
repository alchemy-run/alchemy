export const SOCKET_USER_ENTRY = "user-entry";
export const SERVICE_USER_WORKER = "user-worker";

/** Newest date supported by catalog workerd 1.20260831.1. Used by internal isolates. */
export const INTERNAL_WORKER_COMPATIBILITY_DATE = "2026-08-31";

export const defaultDurableObjectUniqueKey = (
  scriptName: string,
  className: string,
) => `${encodeURIComponent(scriptName)}-${encodeURIComponent(className)}`;
