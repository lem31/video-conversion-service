# --- Builder stage: install dependencies and produce node_modules ---
FROM node:18-bookworm AS builder
WORKDIR /app

# Copy package files and install production deps reproducibly (use npm ci when lockfile exists, fallback to npm install)
COPY package*.json ./
RUN if [ -f package-lock.json ]; then \
      echo "package-lock.json found — running npm ci"; \
      npm ci --only=production --no-audit --no-fund; \
    else \
      echo "No package-lock.json — running npm install"; \
      npm install --only=production --no-audit --no-fund; \
    fi

# Copy app sources (no build step assumed; if you have one, run it here)
COPY . .

# --- Final runtime stage: smaller surface, non-root user ---
FROM node:18-bookworm-slim

# Basic env + sensible defaults
ENV NODE_ENV=production
ENV MAX_CONCURRENT_DOWNLOADS=2
ENV VIDEO_CACHE_DIR=/data/video_cache
ENV PATH="/usr/local/bin:$PATH"
ENV FFMPEG_PATH=/usr/bin/ffmpeg

# Prefer /dev/shm for temporary work inside container (can be overridden by YTDLP_TMP_DIR)
# Note: at runtime you should start the container with a larger shared memory, e.g.:
#   docker run --shm-size=1g ...
ENV TMPDIR=/dev/shm
ENV YTDLP_TMP_DIR=/dev/shm

# Install only runtime packages (ensure python3 present for yt-dlp)
RUN apt-get update && apt-get install -y --no-install-recommends \
  ffmpeg \
  curl \
  ca-certificates \
  python3 \
  && rm -rf /var/lib/apt/lists/*

# Create a non-root user and home dir
RUN groupadd -r appuser && useradd -r -g appuser -d /home/appuser -s /sbin/nologin appuser \
  && mkdir -p /home/appuser && chown -R appuser:appuser /home/appuser

# Install yt-dlp standalone binary (avoid pip), keep executable
RUN curl -fsSL -o /usr/local/bin/yt-dlp \
      https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  && chmod 755 /usr/local/bin/yt-dlp \
  && /usr/local/bin/yt-dlp --version || true

# Create cache directory owned by appuser (no 777)
RUN mkdir -p /tmp && chmod 1777 /tmp \
  && mkdir -p "${VIDEO_CACHE_DIR}" && chown -R appuser:appuser "${VIDEO_CACHE_DIR}"

# App working directory
WORKDIR /app

# Copy built app and node_modules from builder, set ownership to appuser
COPY --chown=appuser:appuser --from=builder /app /app

# Switch to non-root user
USER appuser

# Expose port and keep lightweight healthcheck
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -fsS http://localhost:8080/health || exit 1

# Use same start command as before
CMD ["npm", "start"]
