FROM node:18

# Install ffmpeg and python (required by yt-dlp)
RUN apt-get update \
  && apt-get install -y ffmpeg python3 python3-pip \
  && apt-get clean

# Install yt-dlp via pip (more reliable than apt)
RUN apk add --no-cache ffmpeg yt-dlp python3 py3-pip

   # Verify yt-dlp installation and show version
  RUN yt-dlp --version

# Fix permissions for /tmp so yt-dlp can write files there
RUN chmod 777 /tmp

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8080

CMD ["npm", "start"]
