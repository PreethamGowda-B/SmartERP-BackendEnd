# Use Node 18 Alpine for a lightweight image
FROM node:18-alpine

# Set working directory inside the container
WORKDIR /usr/src/app

# Copy package files first to leverage Docker cache
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && npm rebuild --unsafe-perm

# Copy the rest of the app
COPY . .

# Expose backend port
EXPOSE 4000

# Default command to run the server
CMD ["node", "server.js"]
# If you need to run in development mode, uncomment the following line and comment the above CMD
# CMD ["npm", "run", "dev"] 