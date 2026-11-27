# A customer-managed runtime: the Lambda Node.js 24 base image plus a marker
# file, so a function can report which runtime version it ran on.
FROM public.ecr.aws/lambda/nodejs:24
ARG MARKER=v1
RUN printf '%s' "$MARKER" > /var/runtime/runtime-info.txt
