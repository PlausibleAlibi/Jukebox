# Party Jukebox Dockerfile
# Build: docker build -t jukebox .
# Run: docker run -p 3000:3000 --env-file .env jukebox

FROM node:20-alpine

# Create non-root user for security
RUN addgroup -g 1001 -S jukebox && \
    adduser -S jukebox -u 1001 -G jukebox

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# Copy application files
COPY --chown=jukebox:jukebox . .

# Switch to non-root user
USER jukebox

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/status || exit 1

# Start the application
CMD ["node", "server.js"]
