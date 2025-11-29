#!/bin/bash
# Party Jukebox Docker Start Script
# Usage: ./docker-start.sh
#
# This script starts the Party Jukebox Docker container using docker-compose.
# The container runs on HTTPS port 443 by default.
#
# Prerequisites:
# 1. Docker and docker-compose installed
# 2. SSL certificates in ./certs/ directory
# 3. .env file configured with Spotify credentials and SSL paths

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

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

# Check for certs directory
if [ ! -d "certs" ]; then
    echo "Warning: certs/ directory not found."
    echo "For HTTPS mode, create certificates:"
    echo "  mkdir -p certs"
    echo "  cd certs"
    echo "  mkcert 192.168.x.x localhost"
    echo ""
fi

# Start the container
echo "Starting Party Jukebox container..."
docker-compose up -d

# Show status
echo ""
echo "Container status:"
docker-compose ps

echo ""
echo "========================================"
echo "Party Jukebox started successfully!"
echo "Access the app at: https://localhost/"
echo "(Replace localhost with your LAN IP for other devices)"
echo "========================================"
