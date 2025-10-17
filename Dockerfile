# Minimal Node image with Python + requests/curl_cffi to support yt-dlp HTTPS proxy usage.
FROM node:18-bullseye-slim

# Install minimal system deps and Python/pip
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      python3 python3-pip ca-certificates ffmpeg wget && \
    rm -rf /var/lib/apt/lists/*

# Install Python packages that yt-dlp can rely on for HTTPS proxy support
# (requests is sufficient in most cases; curl_cffi is optional)
RUN pip3 install --no-cache-dir requests curl_cffi yt-dlp

# Install node deps and copy app
WORKDIR /app
COPY package*.json ./

# Use package-lock.json when available; fall back to npm install --omit=dev when not present.
# This prevents `npm ci` from failing in environments without a lockfile.
RUN if [ -f package-lock.json ]; then \
      echo "Found package-lock.json → using npm ci"; \
      npm ci --only=production; \
    else \
      echo "No package-lock.json → using npm install --omit=dev"; \
      npm install --omit=dev --no-audit --no-fund; \
    fi

# Copy source
COPY . .

# Build-time sanity check: ensure index.js exists (fail fast if code got removed)
RUN test -f index.js || (echo "ERROR: index.js missing — build aborted (possible accidental removal)." && exit 1)

EXPOSE 8080

# Run the app
CMD ["node", "index.js"]
