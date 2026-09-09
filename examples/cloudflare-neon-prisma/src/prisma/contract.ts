import { defineContract } from "@prisma/orm-postgres/contract-builder";

export const contract = defineContract({}, ({ field, model, rel }) => ({
  models: {
    User: model("User", {
      fields: {
        id: field.id.uuidv7Native(),
        email: field.text().unique(),
        name: field.text(),
        createdAt: field.temporal.createdAtString(),
      },
      relations: {
        posts: rel.hasMany("Post", { by: "authorId" }),
      },
    }),

    Post: model("Post", {
      fields: {
        id: field.id.uuidv7Native(),
        title: field.text(),
        authorId: field.uuidNative(),
      },
      relations: {
        author: rel.belongsTo("User", { from: "authorId", to: "id" }),
      },
    }),
  },
}));
