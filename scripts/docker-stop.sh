#!/bin/bash
# Party Jukebox Docker Stop Script
# Usage: ./docker-stop.sh
#
# This script stops and removes the Party Jukebox Docker container.
# Logs are preserved in the ./logs/ directory.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Configuration
CONTAINER_NAME="jukebox"

echo "========================================"
echo "Party Jukebox Docker Stop"
echo "========================================"

# Check if container exists
if ! docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "No Party Jukebox container found."
    exit 0
fi

# Check if container is running
if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "Stopping Party Jukebox container..."
    docker stop "${CONTAINER_NAME}"
fi

# Remove the container
echo "Removing container..."
docker rm "${CONTAINER_NAME}"

echo ""
echo "========================================"
echo "Party Jukebox stopped successfully!"
echo "Logs are preserved in: ./logs/"
echo "To start again: ./docker-start.sh"
echo "========================================"
