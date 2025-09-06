export type Resource<ID extends string = string> = {
  id: ID;
  new (_: never): { id: ID };
};
