FROM node:18

# Update package list
RUN apt-get update

# Install ffmpeg, curl, and Python (optional, for other tools)
RUN apt-get install -y ffmpeg curl python3

# Install latest yt-dlp binary directly
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

# Confirm yt-dlp version
RUN yt-dlp --version

# Ensure /tmp exists and is writable
RUN mkdir -p /tmp && chmod 777 /tmp

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

EXPOSE 8080

CMD ["npm", "start"]
