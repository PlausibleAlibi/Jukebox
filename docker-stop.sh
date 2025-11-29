#!/bin/bash
# Party Jukebox Docker Stop Script
# Usage: ./docker-stop.sh
#
# This script stops the Party Jukebox Docker container.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================"
echo "Party Jukebox Docker Stop"
echo "========================================"

# Check if container is running
if ! docker-compose ps --quiet 2>/dev/null | grep -q .; then
    echo "No Party Jukebox containers are running."
    exit 0
fi

# Stop the container
echo "Stopping Party Jukebox container..."
docker-compose down

echo ""
echo "========================================"
echo "Party Jukebox stopped successfully!"
echo "========================================"
