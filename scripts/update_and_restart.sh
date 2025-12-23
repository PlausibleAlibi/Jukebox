#!/bin/bash
#
# update_and_restart.sh
# 
# Automates updating the local Party Jukebox repository and restarting the service.
#
# Usage:
#   ./update_and_restart.sh [--skip-deps]
#
# Options:
#   --skip-deps    Skip npm dependency installation (use when dependencies haven't changed)
#
# Requirements:
#   - Git must be installed and configured
#   - Node.js and npm must be installed
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

# Parse command line arguments
SKIP_DEPS=false
while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-deps)
            SKIP_DEPS=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--skip-deps]"
            exit 1
            ;;
    esac
done

# ==============================================================================
# SCRIPT LOGIC - No need to modify below this line
# ==============================================================================

echo "========================================"
echo "Party Jukebox Update and Restart Script"
echo "========================================"
echo ""

# Step 1: Navigate to repository directory
echo "[1/5] Navigating to repository directory: $REPO_DIR"
if [ ! -d "$REPO_DIR" ]; then
    echo "ERROR: Repository directory '$REPO_DIR' does not exist."
    exit 1
fi
cd "$REPO_DIR"
echo "      Current directory: $(pwd)"
echo ""

# Step 2: Pull latest code from remote repository
echo "[2/5] Pulling latest code from remote repository..."
echo "      Fetching latest changes..."
if git fetch origin; then
    echo "      Resetting to origin/main..."
    if git reset --hard origin/main; then
        echo "      Code updated successfully."
    else
        echo "ERROR: Failed to reset to remote repository state."
        exit 1
    fi
else
    echo "ERROR: Failed to fetch from remote repository."
    exit 1
fi
echo ""

# Step 3: Install npm dependencies
if [ "$SKIP_DEPS" = true ]; then
    echo "[3/5] Skipping npm dependency installation (--skip-deps flag provided)..."
    echo "      Dependencies not updated."
else
    echo "[3/5] Installing npm dependencies..."
    echo "      Running: npm install --production --no-audit --no-fund"
    
    # Check if package.json exists
    if [ ! -f "package.json" ]; then
        echo "ERROR: package.json not found in $REPO_DIR."
        echo "      Cannot install npm dependencies without package.json."
        exit 1
    fi
    
    # Check if npm is available
    if ! command -v npm &> /dev/null; then
        echo "ERROR: npm command not found. Please install Node.js and npm."
        exit 1
    fi
    
    # Run npm install with --production flag to skip devDependencies
    # --no-audit and --no-fund flags prevent audit warnings and funding messages from being displayed
    if npm install --production --no-audit --no-fund; then
        echo "      Dependencies installed successfully."
    else
        echo "ERROR: Failed to install npm dependencies."
        echo "      This may cause the service to fail if new dependencies were added."
        echo "      Please check the npm error output above and try running 'npm install --production --no-audit --no-fund' manually."
        exit 1
    fi
fi
echo ""

# Step 4: Update LAST_UPDATED.txt with current timestamp
echo "[4/5] Updating LAST_UPDATED.txt..."
TIMESTAMP=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
echo "$TIMESTAMP" > LAST_UPDATED.txt
echo "      Timestamp written: $TIMESTAMP"
echo ""

# Step 5: Restart the jukebox systemd service
echo "[5/5] Restarting $SERVICE_NAME service..."
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
