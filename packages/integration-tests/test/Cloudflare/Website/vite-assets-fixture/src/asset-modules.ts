// Types for the asset imports in index.ts (a script, so the declarations are ambient).
declare module "*.svg" {
  const url: string;
  export default url;
}
declare module "*?url" {
  const url: string;
  export default url;
}
declare module "*?inline" {
  const url: string;
  export default url;
}
declare module "*?no-inline" {
  const url: string;
  export default url;
}
declare module "*?raw" {
  const source: string;
  export default source;
}
declare module "*.txt" {
  const text: string;
  export default text;
}
