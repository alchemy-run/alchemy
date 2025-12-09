export type USER = typeof USER;
export const USER = import.meta.env.USER ?? import.meta.env.USERNAME ?? "unknown";
