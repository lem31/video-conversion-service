FROM node:18

# Update package list
RUN apt-get update

# Install ffmpeg and Python
RUN apt-get install -y ffmpeg python3 python3-pip curl

# Install latest yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp

# Optional: install Python dependencies for yt-dlp
RUN pip3 install --upgrade pip setuptools wheel \
  && pip3 install -U yt-dlp

# Confirm yt-dlp version
RUN yt-dlp --version

# Clean up
RUN apt-get clean

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
