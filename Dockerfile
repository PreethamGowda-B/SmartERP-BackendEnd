# Use Node 18 Alpine
FROM node:18-alpine

# Set working directory
WORKDIR /usr/src/app

# Copy package files first
COPY package*.json ./

# Install all dependencies (including devDependencies)
RUN npm ci && npm rebuild --unsafe-perm

# Copy the rest of the app
COPY . .

# Expose backend port
EXPOSE 4000

# Default command for development
CMD ["npm", "run", "dev"]
