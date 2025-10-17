FROM node:18-bookworm

# avoid prompts during apt operations
ENV DEBIAN_FRONTEND=noninteractive
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV PATH="/usr/local/bin:$PATH"
ENV FFMPEG_PATH=/usr/bin/ffmpeg

# Install system dependencies and build tools required for some pip packages
# Added sqlite3 and libsqlite3-dev for browser cookie extraction support
RUN apt-get update && apt-get install -y --no-install-recommends \
  ffmpeg \
  curl \
  python3 \
  python3-pip \
  ca-certificates \
  libmp3lame-dev \
  git \
  build-essential \
  python3-dev \
  libssl-dev \
  libffi-dev \
  sqlite3 \
  libsqlite3-dev \
  && rm -rf /var/lib/apt/lists/*

# Upgrade pip tooling then install yt-dlp via pip
# REPLACED: pip installs caused "externally-managed-environment" errors on some images.
# Instead download the yt-dlp standalone binary and make it executable.
RUN curl -fsSL -o /usr/local/bin/yt-dlp \
      https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp \
  && /usr/local/bin/yt-dlp --version || true

# Ensure yt-dlp is in PATH (pip usually installs to /usr/local/bin)
ENV PATH="/usr/local/bin:$PATH"

# Create temp directory with open permissions
RUN mkdir -p /tmp && chmod 777 /tmp

# Set working directory
WORKDIR /app

# Install Node.js dependencies
COPY package*.json ./

# Keep npm install (safe if lockfile may be missing); switch to npm ci if you have package-lock.json and want reproducible installs
RUN npm install --no-audit --no-fund

# Copy app files
COPY . .

# Expose port and start app
EXPOSE 8080

# Optional lightweight healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -fsS http://localhost:8080/health || exit 1

CMD ["npm", "start"]
