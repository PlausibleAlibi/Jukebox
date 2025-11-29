# Party Jukebox Dockerfile
# Build: docker build -t jukebox .
# Run: docker run -p 443:443 --env-file .env -v ./certs:/app/certs:ro -v ./logs:/app/logs jukebox
#
# HTTPS Configuration:
# This container runs on HTTPS port 443 by default.
# Mount your SSL certificates to /app/certs and configure via .env:
#   SSL_CERT_PATH=/app/certs/your-cert.pem
#   SSL_KEY_PATH=/app/certs/your-key.pem
#   SSL_PORT=443
#
# Volume Mounts:
#   - ./certs:/app/certs:ro  - SSL certificates (read-only)
#   - ./logs:/app/logs       - Application logs (persistent)
#
# Log Directory Permissions:
# The container runs as a non-root user 'jukebox' (UID 1001) for security.
# Before running, ensure the host logs directory is writable:
#   mkdir -p logs && chmod 777 logs
# Or match the container user:
#   mkdir -p logs && sudo chown 1001:1001 logs

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

# Create logs directory with proper permissions for the non-root user
RUN mkdir -p /app/logs && chown jukebox:jukebox /app/logs && chmod 755 /app/logs

# Switch to non-root user
USER jukebox

# Expose HTTPS port (443 by default for HTTPS mode)
EXPOSE 443

# Health check using HTTPS with self-signed certificate support
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider --no-check-certificate https://localhost:443/api/status || exit 1

# Start the application
CMD ["node", "server.js"]
