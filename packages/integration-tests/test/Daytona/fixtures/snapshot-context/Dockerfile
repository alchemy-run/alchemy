FROM node:22-bookworm-slim
ARG GREETING=hello
COPY app/ /opt/app/
RUN echo "$GREETING" > /opt/app/greeting && node /opt/app/check.js
