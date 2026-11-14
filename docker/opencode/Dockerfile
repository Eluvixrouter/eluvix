FROM node:20-alpine
WORKDIR /app
COPY server.mjs /app/server.mjs
EXPOSE 4096
HEALTHCHECK --interval=5s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:4096/health || exit 1
CMD ["node", "/app/server.mjs"]
