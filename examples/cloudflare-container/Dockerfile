FROM oven/bun:latest

WORKDIR /app

RUN echo "export default { fetch: () => new Response('Hello, world!') }" > src/index.ts

EXPOSE 8080

CMD ["bun", "--port=8080", "src/index.ts"]
