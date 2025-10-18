# Use Node 18 Alpine for lightweight image
FROM node:18-alpine

# Set working directory
WORKDIR /usr/src/app

# Copy package files first (leverages Docker cache)
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev && npm rebuild --unsafe-perm

# Copy the rest of the app
COPY . .

# Expose backend port
EXPOSE 4000

# Start the server
CMD ["node", "server.js"]
