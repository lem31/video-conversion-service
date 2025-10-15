FROM node:18

# Install ffmpeg, python3, and yt-dlp using apt-get
RUN apt-get update \
  && apt-get install -y ffmpeg python3 python3-pip yt-dlp \
  && apt-get clean

# Verify yt-dlp installation and show version
RUN yt-dlp --version

# Fix permissions for /tmp so yt-dlp can write files there
RUN chmod 777 /tmp

# Add: Ensure /tmp exists and is writable for yt-dlp and ffmpeg
RUN mkdir -p /tmp && chmod 777 /tmp

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# If your main file is index.js, make sure it exists in /app after COPY . .
# If your entry point is not index.js, update CMD accordingly:
# CMD ["npm", "start"]  # if "start": "node index.js" in package.json
# Or use: CMD ["node", "index.js"] if you want to run index.js directly

EXPOSE 8080

CMD ["npm", "start"]
