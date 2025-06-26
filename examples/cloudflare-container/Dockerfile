FROM oven/bun:latest

WORKDIR /app

COPY . .

RUN sed -i 's/"workspace:\*"/"latest"/g' package.json

RUN bun install

CMD ["bun", "run", "start"]
