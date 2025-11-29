#!/bin/bash
# Party Jukebox Docker Start Script
# Usage: ./docker-start.sh
#
# This script starts the Party Jukebox Docker container with proper volume mounts.
# The container runs on HTTPS port 443 by default.
#
# Mounts:
# - .env file for configuration
# - ./certs/ for SSL certificates
# - ./logs/ for application logs
#
# Prerequisites:
# 1. Docker installed
# 2. SSL certificates in ./certs/ directory
# 3. .env file configured with Spotify credentials and SSL paths

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Configuration
CONTAINER_NAME="jukebox"
HOST_PORT="${HOST_PORT:-443}"
CONTAINER_PORT="443"
IMAGE_NAME="jukebox"

echo "========================================"
echo "Party Jukebox Docker Start"
echo "========================================"

# Check for .env file
if [ ! -f ".env" ]; then
    echo "Error: .env file not found!"
    echo "Please copy .env.example to .env and configure your settings."
    echo "  cp .env.example .env"
    exit 1
fi

# Create certs directory if it doesn't exist
if [ ! -d "certs" ]; then
    echo "Warning: certs/ directory not found. Creating it..."
    mkdir -p certs
    echo "Please add your SSL certificates to the certs/ directory:"
    echo "  cd certs"
    echo "  mkcert 192.168.x.x localhost"
    echo ""
fi

# Create logs directory if it doesn't exist
if [ ! -d "logs" ]; then
    echo "Creating logs/ directory..."
    mkdir -p logs
fi

# Check if container is already running
if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "Container '${CONTAINER_NAME}' is already running."
    echo "Use ./docker-stop.sh to stop it first, or docker logs ${CONTAINER_NAME} to view logs."
    exit 0
fi

# Remove stopped container if it exists
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "Removing stopped container '${CONTAINER_NAME}'..."
    docker rm "${CONTAINER_NAME}" > /dev/null
fi

# Build the image if it doesn't exist
if ! docker images --format '{{.Repository}}' | grep -q "^${IMAGE_NAME}$"; then
    echo "Building Docker image '${IMAGE_NAME}'..."
    docker build -t "${IMAGE_NAME}" .
fi

# Start the container with volume mounts
echo "Starting Party Jukebox container..."
echo "  - Port mapping: ${HOST_PORT}:${CONTAINER_PORT}"
echo "  - Environment: .env"
echo "  - Certificates: ./certs -> /app/certs"
echo "  - Logs: ./logs -> /app/logs"

docker run -d \
    --name "${CONTAINER_NAME}" \
    --restart unless-stopped \
    -p "${HOST_PORT}:${CONTAINER_PORT}" \
    --env-file .env \
    -v "$(pwd)/certs:/app/certs:ro" \
    -v "$(pwd)/logs:/app/logs" \
    "${IMAGE_NAME}"

# Wait for container to start
sleep 2

# Show status
echo ""
echo "Container status:"
docker ps --filter "name=${CONTAINER_NAME}" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo ""
echo "========================================"
echo "Party Jukebox started successfully!"
echo "Access the app at: https://localhost:${HOST_PORT}/"
echo "(Replace localhost with your LAN IP for other devices)"
echo ""
echo "Useful commands:"
echo "  View logs:    docker logs -f ${CONTAINER_NAME}"
echo "  Stop:         ./docker-stop.sh"
echo "  Shell access: docker exec -it ${CONTAINER_NAME} sh"
echo "========================================"
