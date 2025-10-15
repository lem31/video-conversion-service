FROM node:18

# Install dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg python3 python3-pip aria2 && \
    pip3 install --no-cache-dir yt-dlp && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy source code
COPY . .

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/ || exit 1

CMD ["npm", "start"]
