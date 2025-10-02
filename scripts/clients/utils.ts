export const keys = <T extends object>(obj: T): (keyof T)[] =>
  Object.keys(obj) as (keyof T)[];

export const toCamelCase = (str: string) => {
  return str
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, letter) => letter.toUpperCase())
    .replace(/^./, (match) => match.toLowerCase());
};

export const methods = ["get", "post", "put", "delete", "patch"] as const;

export const isMethod = (method: string): method is (typeof methods)[number] =>
  methods.includes(method as (typeof methods)[number]);
