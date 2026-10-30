FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir -p /data/whatsapp && chown -R node:node /app /data
COPY --chown=node:node server ./server
COPY --chown=node:node dist ./dist
USER node
ENV NODE_ENV=production AUTH_DIR=/data/whatsapp PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","server/index.mjs"]
