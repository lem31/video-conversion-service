FROM node:18

# Install ffmpeg, python3, and yt-dlp using apt-get
RUN apt-get update \
  && apt-get install -y ffmpeg python3 python3-pip yt-dlp \
  && apt-get clean

# Verify yt-dlp installation and show version
RUN yt-dlp --version

# Ensure /tmp exists and is writable for yt-dlp and ffmpeg
RUN mkdir -p /tmp && chmod 777 /tmp

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8080

CMD ["npm", "start"]
