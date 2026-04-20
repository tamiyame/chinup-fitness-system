# Use Node 24 to get built-in node:sqlite module
FROM node:24-alpine

WORKDIR /app

# Install deps first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Ensure data directory exists (volume will mount over it)
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "src/server.js"]
