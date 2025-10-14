FROM node:18

# Install ffmpeg and python (required by yt-dlp)
RUN apt-get update \
  && apt-get install -y ffmpeg python3 python3-pip \
  && apt-get clean

# Install yt-dlp
RUN pip3 install yt-dlp

# Fix permissions for /tmp so yt-dlp can write files there
RUN chmod 777 /tmp

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8080

CMD ["npm", "start"]
