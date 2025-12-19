# Party Jukebox Dockerfile
# Build: docker build -t jukebox .
# Run: docker run -p 443:443 --env-file .env -v ./certs:/app/certs:ro -v ./logs:/app/logs -v ./data:/app/data jukebox
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
#   - ./data:/app/data       - SQLite database (persistent)
#
# Log Directory Permissions:
# The container runs as a non-root user 'jukebox' (UID 1001) for security.
# Before running, ensure the host logs and data directories are writable:
#   mkdir -p logs data && sudo chown 1001:1001 logs data
# Alternative (less secure):
#   mkdir -p logs data && chmod 775 logs data

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

# Create logs and data directories with proper permissions for the non-root user
RUN mkdir -p /app/logs /app/data && \
    chown jukebox:jukebox /app/logs /app/data && \
    chmod 755 /app/logs /app/data

# Switch to non-root user
USER jukebox

# Expose HTTPS port (443 by default for HTTPS mode)
EXPOSE 443

# Health check using HTTPS with self-signed certificate support
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider --no-check-certificate https://localhost:443/api/status || exit 1

# Start the application
CMD ["node", "server.js"]
