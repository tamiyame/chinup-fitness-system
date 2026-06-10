# Use Node 24 to get built-in node:sqlite module
FROM node:24-alpine

WORKDIR /app

# 全系統時間為台北牆鐘字串；容器時區必須對齊（Node/V8 讀 TZ 不需 OS tzdata）
ENV TZ=Asia/Taipei

# Install deps first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Ensure data directory exists (volume will mount over it)
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "src/server.js"]
