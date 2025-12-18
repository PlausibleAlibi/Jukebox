#!/bin/bash
#
# update_and_restart.sh
# 
# Automates updating the local Party Jukebox repository and restarting the service.
#
# Usage:
#   ./update_and_restart.sh
#
# Requirements:
#   - Git must be installed and configured
#   - systemd service must be set up (see deploy/jukebox.service)
#   - Script must be run with sufficient permissions to restart the service
#

set -e

# ==============================================================================
# CONFIGURATION - Customize these variables as needed
# ==============================================================================

# Path to the jukebox repository directory
REPO_DIR="/opt/jukebox"

# Name of the systemd service
SERVICE_NAME="jukebox"

# ==============================================================================
# SCRIPT LOGIC - No need to modify below this line
# ==============================================================================

echo "========================================"
echo "Party Jukebox Update and Restart Script"
echo "========================================"
echo ""

# Step 1: Navigate to repository directory
echo "[1/4] Navigating to repository directory: $REPO_DIR"
if [ ! -d "$REPO_DIR" ]; then
    echo "ERROR: Repository directory '$REPO_DIR' does not exist."
    exit 1
fi
cd "$REPO_DIR"
echo "      Current directory: $(pwd)"
echo ""

# Step 2: Pull latest code from remote repository
echo "[2/4] Pulling latest code from remote repository..."
if git pull; then
    echo "      Code updated successfully."
else
    echo "ERROR: Failed to pull latest code from remote repository."
    exit 1
fi
echo ""

# Step 3: Update LAST_UPDATED.txt with current timestamp
echo "[3/4] Updating LAST_UPDATED.txt..."
TIMESTAMP=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
echo "$TIMESTAMP" > LAST_UPDATED.txt
echo "      Timestamp written: $TIMESTAMP"
echo ""

# Step 4: Restart the jukebox systemd service
echo "[4/4] Restarting $SERVICE_NAME service..."
if systemctl restart "$SERVICE_NAME"; then
    echo "      Service restarted successfully."
else
    echo "ERROR: Failed to restart $SERVICE_NAME service."
    echo "      Make sure you have sufficient permissions (try running with sudo)."
    exit 1
fi
echo ""

echo "========================================"
echo "Update and restart completed successfully!"
echo "========================================"
