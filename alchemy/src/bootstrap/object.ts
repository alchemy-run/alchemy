export type DurableObject<T extends (...args: any[]) => any> = T & {
  meta: ImportMeta;
  type: "object";
  id: string;
};

export async function DurableObject<T extends (...args: any[]) => any>(
  meta: ImportMeta,
  id: string,
  obj: T,
) {
  return new Proxy(obj, {});
}
