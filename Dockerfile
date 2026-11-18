# Chạy bằng Docker (VPS, Railway, Fly.io…). Dữ liệu lưu ở /data – gắn ổ đĩa bền vào đường dẫn này.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV DATA_DIR=/data PORT=3000 TRUST_PROXY=1
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server.js"]
