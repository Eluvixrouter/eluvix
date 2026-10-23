FROM node:20-alpine
WORKDIR /app
COPY server.mjs ./
EXPOSE 1933
HEALTHCHECK --interval=5s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:1933/health || exit 1
# Run as the image's unprivileged node user (audit L-17)
USER node
CMD ["node", "server.mjs"]
