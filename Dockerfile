FROM node:18

# Install system dependencies (no aria2)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3 python3-pip && \
    pip3 install --no-cache-dir yt-dlp && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/ || exit 1

CMD ["npm", "start"]
