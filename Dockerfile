# Minimal Node image with Python + requests/curl_cffi to support yt-dlp HTTPS proxy usage.
FROM node:18-bookworm-slim

# Install minimal system deps and Python/pip
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      python3 python3-pip ca-certificates ffmpeg wget && \
    rm -rf /var/lib/apt/lists/*

# Install Python 3.11 and venv tools
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      python3.11 python3.11-venv ca-certificates ffmpeg wget && \
    ln -sf /usr/bin/python3.11 /usr/bin/python3 && \
    rm -rf /var/lib/apt/lists/*

# Create and activate virtual environment
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install Python packages inside the venv
RUN pip install --no-cache-dir requests curl_cffi yt-dlp


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
