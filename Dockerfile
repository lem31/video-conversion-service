FROM node:18-bullseye

# Install dependencies
RUN apt-get update && apt-get install -y \
  ffmpeg \
  curl \
  python3 \
  python3-pip \
  ca-certificates \
  libmp3lame-dev \
  && apt-get clean

# Install yt-dlp via pip (more reliable and updatable)
RUN pip3 install -U yt-dlp

# Ensure yt-dlp is in PATH
ENV PATH="/usr/local/bin:$PATH"

# Optional: Set ffmpeg path explicitly if needed
ENV FFMPEG_PATH=/usr/bin/ffmpeg

# Create temp directory with open permissions
RUN mkdir -p /tmp && chmod 777 /tmp

# Set working directory
WORKDIR /app

# Install Node.js dependencies
COPY package*.json ./
RUN npm install

# Copy app files
COPY . .

# Expose port and start app
EXPOSE 8080
CMD ["npm", "start"]
