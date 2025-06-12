export type ModeType =
  | "dev"
  | "live"
  | "hybrid-prefer-live"
  | "hybrid-prefer-dev"; // | "hybrid";
export const DEFAULT_MODE = "hybrid-prefer-live";

// export function localModeOnlyHandler(
//     this: Context<any, any>,
//     id: string,
//     props: {
//       path: string;
//       content: string;
//     },
//   ) {
//     throw new Er
//   }
