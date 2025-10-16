FROM node:18-bullseye

RUN apt-get update && apt-get install -y \
  ffmpeg \
  curl \
  python3 \
  ca-certificates \
  libmp3lame-dev

RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV PATH="/usr/local/bin:$PATH"

RUN mkdir -p /tmp && chmod 777 /tmp

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8080
CMD ["npm", "start"]
