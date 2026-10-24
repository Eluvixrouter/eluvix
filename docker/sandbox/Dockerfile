FROM node:20-alpine
WORKDIR /app
COPY server.mjs ./
EXPOSE 3986
HEALTHCHECK --interval=5s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:3986/health || exit 1
CMD ["node", "server.mjs"]
