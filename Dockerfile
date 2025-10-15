FROM node:18

# Update package list
RUN apt-get update

# Install ffmpeg, python, and yt-dlp
RUN apt-get install -y ffmpeg python3 python3-pip yt-dlp

# Clean up
RUN apt-get clean

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

EXPOSE 8080

CMD ["npm", "start"]
