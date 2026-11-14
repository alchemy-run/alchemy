FROM golang:1.22 AS build
RUN go build -o /out/app .
FROM gcr.io/distroless/static
COPY --from=build /out/app /app
