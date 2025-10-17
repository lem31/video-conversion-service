# Minimal Node image with Python + requests/curl_cffi to support yt-dlp HTTPS proxy usage.
FROM node:18-bookworm-slim

# Install minimal system deps and Python/pip
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv ca-certificates ffmpeg wget && \
    rm -rf /var/lib/apt/lists/*

# Create an isolated virtualenv and install Python deps there to avoid
# "externally-managed-environment" (PEP 668) errors when installing system-wide.
RUN python3 -m venv /opt/pyenv && \
    /opt/pyenv/bin/pip install --upgrade pip setuptools wheel && \
    /opt/pyenv/bin/pip install --no-cache-dir requests curl_cffi yt-dlp && \
    rm -rf /root/.cache /var/lib/apt/lists/*

# Put venv binaries (yt-dlp, pip, etc.) on PATH
ENV PATH="/opt/pyenv/bin:${PATH}"

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
