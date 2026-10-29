/**
 * Env vars naming the bridge an emulated Function's real-cloud event
 * sources reach it through: set on the stub (where it sends invocations)
 * and on the emulated Function (so the dev sidecar knows what to consume).
 * See `Lambda/DevBridge.ts` and `Local/DevBridgeRelay.ts`.
 */
export const DEV_BRIDGE_ENV = {
  queueUrl: "ALCHEMY_DEV_BRIDGE_QUEUE_URL",
  bucket: "ALCHEMY_DEV_BRIDGE_BUCKET",
} as const;
