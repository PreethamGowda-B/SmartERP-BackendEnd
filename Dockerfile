# Stage 1: Build dependencies
FROM node:20-slim AS builder

# Set working directory
WORKDIR /usr/src/app

# Copy package files to leverage Docker cache
COPY package*.json ./

# Install only production dependencies
# node:20-slim guarantees glibc, which allows fast pre-built binary downloads 
# for native modules like bcrypt and @sentry/profiling-node.
RUN npm ci --omit=dev

# Stage 2: Production runtime image
FROM node:20-slim

WORKDIR /usr/src/app

# Set node environment
ENV NODE_ENV=production

# Copy dependencies directly from the builder stage
COPY --from=builder /usr/src/app/node_modules ./node_modules

# Copy application source code
COPY . .

# Expose backend port
EXPOSE 4000

# Start the application inside the container
CMD ["node", "server.js"]
