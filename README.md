# 🎵 Party Jukebox

A lightweight web application that allows guests on your local network to search Spotify for songs and add them to your playback queue. Perfect for parties, gatherings, or any event where you want collaborative music selection!

## Features

- **Simple Setup**: Just configure your Spotify credentials and run
- **Customizable Branding**: Configure app title and byline via environment variables
- **LAN-Friendly**: Guests connect via your local network IP
- **Mobile-Optimized**: Fully responsive design works great on phones and tablets
- **Real-Time**: Shows currently playing track and Spotify queue
- **Secure**: Only the host needs a Spotify account; guests just search and add
- **QR Code Sharing**: Generate QR codes for guests to easily join on mobile
- **Queue Voting**: Users can upvote songs to influence play order
- **Track Limits**: Prevent queue flooding with per-device track limits (toggleable)
- **Host Admin Panel**: Skip tracks, pause/play, clear queue, reset limits, and toggle track enforcement
- **Analytics Dashboard**: Visualize party statistics, top tracks, most active users, and peak hours
- **RFC 8252 Compliant OAuth**: Dynamic loopback port selection for desktop apps

## Quick Start

### Prerequisites

- Node.js 18 or higher
- A Spotify Premium account (required for playback control)
- A Spotify Developer application

### 1. Create a Spotify App

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Click "Create App"
3. Fill in:
   - App name: "Party Jukebox" (or any name)
   - App description: Whatever you like
   - Redirect URI: `http://127.0.0.1/callback` (for desktop/local use with dynamic ports)
4. Save your **Client ID** and **Client Secret**

> **Note**: For RFC 8252 compliant OAuth (recommended for desktop apps), Spotify requires the redirect URI to use the loopback IP literal (`127.0.0.1`) rather than `localhost`. The app will dynamically select an available port at runtime.

### 2. Configure Environment

```bash
# Copy the example environment file
cp .env.example .env

# Edit .env with your credentials
# SPOTIFY_CLIENT_ID=your_client_id_here
# SPOTIFY_CLIENT_SECRET=your_client_secret_here
# ADMIN_PASSWORD=your_secure_password  # Optional: for host controls
```

### 3. Install & Run

```bash
npm install
npm start
```

### 4. Connect Spotify

1. Open `http://localhost:3000` in your browser
2. Click "Connect Spotify" and authorize the app
3. Start playing music on any Spotify device

### 5. Share with Guests

Find your local IP address and share `http://<your-ip>:3000` with guests, or use the QR code feature!

```bash
# On Linux/Mac
ip addr | grep inet
# or
hostname -I

# On Windows
ipconfig
```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `SPOTIFY_CLIENT_ID` | Your Spotify app's Client ID | Required |
| `SPOTIFY_CLIENT_SECRET` | Your Spotify app's Client Secret | Required |
| `SPOTIFY_REDIRECT_URI` | OAuth callback URL (set only for server deployments) | Dynamic (RFC 8252) |
| `PORT` | Server port (HTTP mode) | `3000` |
| `APP_TITLE` | Application title shown to users | `Party JukeBox` |
| `APP_BYLINE` | Subtitle/tagline shown to users | `Your collaborative music queue` |
| `MAX_TRACKS_PER_IP` | Maximum tracks a device can queue | `5` |
| `ENFORCE_TRACK_LIMITS` | Enable/disable track limit enforcement | `true` |
| `ADMIN_PASSWORD` | Password for host admin controls | Empty (disabled) |
| `SSL_CERT_PATH` | Path to SSL certificate file | Empty (disabled) |
| `SSL_KEY_PATH` | Path to SSL private key file | Empty (disabled) |
| `SSL_PORT` | HTTPS server port | `443` |
| `SSL_HOST` | IP address/hostname to bind for HTTPS | `0.0.0.0` |
| `LOG_LEVEL` | Logging level (error, warn, info, http, verbose, debug, silly) | `info` |
| `DATABASE_PATH` | Path to SQLite database file | `./data/jukebox.db` |
| `ADMIN_SESSION_EXPIRY` | Admin session expiry in seconds | `86400` (24 hours) |

### Database

Party Jukebox uses SQLite for persistent storage of party data, ensuring your queue, votes, and user sessions survive server restarts.

#### What's Stored

The database maintains:
- **Party Queue**: Tracks added by users with vote counts
- **User Sessions**: Track counts and nicknames per IP address
- **Admin Sessions**: Persistent admin authentication tokens
- **Playback History**: Record of played tracks for analytics

#### Database Location

The database file is stored at `./data/jukebox.db` by default. You can customize the location:

```bash
DATABASE_PATH=./data/jukebox.db
```

The database uses SQLite's Write-Ahead Logging (WAL) mode for better concurrency. You'll see these files:
- `jukebox.db` - Main database file
- `jukebox.db-shm` - Shared memory file (temporary)
- `jukebox.db-wal` - Write-ahead log (temporary)

#### Database Backup

To backup your party data:

```bash
# Backup
cp ./data/jukebox.db ./data/jukebox.backup.db

# Restore
cp ./data/jukebox.backup.db ./data/jukebox.db
```

#### Reset Database

To start fresh (⚠️ **WARNING**: deletes all data):

```bash
rm ./data/jukebox.db ./data/jukebox.db-shm ./data/jukebox.db-wal
# Database will be recreated on next startup
```

#### Persistence Across Restarts

With the database integration:
- ✅ Party queue persists across server restarts
- ✅ Vote counts are preserved
- ✅ User track counts and limits survive restarts
- ✅ Admin sessions remain valid after restart
- ✅ User nicknames are remembered
- ✅ Playback history is tracked over time

#### Database Schema

Party Jukebox uses camelCase naming conventions for all database tables and columns, consistent with JavaScript best practices.

**Tables:**
- `partyQueue` - Tracks added by users with metadata
- `trackVotes` - User votes per track
- `userSessions` - User track counts and nicknames per IP
- `playbackHistory` - Historical playback data for analytics
- `adminSessions` - Persistent admin authentication tokens

**Key Columns:**
- `trackId` - Spotify track identifier
- `spotifyUri` - Full Spotify URI (spotify:track:xxx)
- `addedByIp` - IP address of user who added track
- `voterIp` - IP address of voter
- `ipAddress` - Primary key for user sessions
- `trackCount` - Number of tracks added by user
- `votedAt` - Timestamp when vote was cast (Unix milliseconds)
- `addedAt` - Timestamp when track was added (Unix milliseconds)
- `playedAt` - Timestamp when track was played (Unix milliseconds)
- `albumArt` - URL to album artwork
- `nickname` - User-defined display name

**Schema Migration:**

If you have an existing database with the old snake_case schema (from versions prior to this update), the application will automatically:
1. Detect the old schema on startup
2. Drop all old tables
3. Recreate tables with the new camelCase naming
4. Log a warning about the migration

**Note:** This is acceptable for a party app where queue data is ephemeral and typically only lasts for the duration of an event.

## Analytics Dashboard

Party Jukebox includes a comprehensive analytics dashboard that visualizes your party's music trends and engagement. Access it at `/analytics.html` or via the "📊 Analytics" tab on the main page.

### Features

- **Real-time Statistics**: Total tracks, active users, votes cast, tracks played, and most voted track
- **Top Requested Tracks**: Visual list showing the most popular songs with request counts
- **User Leaderboard**: Ranked list of most active contributors with medals (🥇🥈🥉)
- **Peak Hours Chart**: Bar chart showing when guests are most active throughout the day
- **Auto-refresh**: Optional 30-second automatic data refresh
- **Export Data**: Download all analytics as JSON for external analysis
- **Filter Controls**: View top 5, 10, or 20 results
- **Mobile Responsive**: Fully optimized for viewing on phones and tablets

### Using the Dashboard

1. Navigate to `http://<your-ip>:3000/analytics.html` or click "📊 Analytics" on the main page
2. View real-time statistics and charts
3. Use the dropdown to adjust how many top items to display (5, 10, or 20)
4. Enable "Auto-refresh" to update data every 30 seconds
5. Click "Export JSON" to download all analytics data
6. Your preferences (auto-refresh and filter settings) are saved in localStorage

### Analytics Data

All analytics are calculated from persistent database records:
- Party queue submissions (current and historical)
- Vote activity across all tracks
- User session data (track counts, nicknames per IP)
- Playback history

Data persists across server restarts, giving you a complete picture of your party's activity over time.

### Logging

Party Jukebox uses structured logging with Winston and Morgan for comprehensive monitoring and debugging.

#### Log Files

Logs are written to both the console and rotating log files:

| File | Description |
|------|-------------|
| `logs/jukebox-YYYY-MM-DD.log` | All log messages (rotates daily) |
| `logs/jukebox-error-YYYY-MM-DD.log` | Error-level logs only (rotates daily) |

Log files are automatically rotated daily, with:
- Maximum file size: 20MB
- Retention period: 14 days

#### Log Levels

Party Jukebox supports Winston's hierarchical log levels. Set the `LOG_LEVEL` environment variable to control verbosity:

| Level | Usage | Example Use Case |
|-------|-------|------------------|
| `error` | Failures that prevent operations | Token refresh fails, Spotify API errors |
| `warn` | Potential issues | Rate limits hit, no active device, missing config |
| `info` | Important events (default) | Server start, admin actions, queue operations, API calls |
| `http` | HTTP requests | Automatically logged via Morgan |
| `verbose` | Detailed operational info | Cache hits/misses, token validation, limit checks |
| `debug` | Fine-grained debugging | Request/response bodies, state changes, stack traces |

**Recommended Settings:**

```bash
# Production - Essential events only
LOG_LEVEL=info     # Default, recommended for most deployments
LOG_LEVEL=warn     # Quieter, only warnings and errors

# Troubleshooting - Detailed operational visibility
LOG_LEVEL=verbose  # See cache operations, token checks, IP tracking

# Development/Debugging - Maximum detail
LOG_LEVEL=debug    # Full request/response bodies, stack traces, state changes
```

#### What's Logged at Each Level

**Error Level:**
- Token refresh failures with response details
- Spotify API errors with status codes and error messages
- Network failures and timeouts
- Authentication failures
- Stack traces (at debug level within error logs)

**Warn Level:**
- Rate limit hits (endpoint, IP, request count)
- Admin login failures (invalid passwords)
- No active Spotify device warnings
- Missing configuration warnings
- OAuth state mismatches

**Info Level:**
- Server startup and configuration
- OAuth flow events (started, successful, failed)
- Queue operations (track added, votes changed, tracks removed)
- Admin actions (skip, pause, play, queue management)
- Spotify API calls and response codes
- Token refresh success
- Track limit enforcement actions

**Verbose Level:**
- Token validation checks and results
- Cache hits/misses (playback state, Spotify queue)
- Cache updates with timestamps
- IP track count changes
- Nickname updates
- Limit enforcement toggles
- Admin session validation

**Debug Level:**
- Spotify API request details (method, endpoint, body, headers)
- Spotify API response bodies (especially on errors)
- OAuth state generation and validation
- Token exchange details
- Dynamic port selection for OAuth
- Redirect URI construction
- Request context (method, URL, headers) on errors
- Stack traces for all errors
- Cache operation details

#### Log Format

**Console output**: Human-readable with timestamps and colors
```
2025-01-15 14:30:45 [info]: Party Jukebox server started (HTTP) {"url":"http://localhost:3000","port":3000}
2025-01-15 14:31:12 [verbose]: Playback cache hit {"cacheAgeMs":5432,"cacheAgeSeconds":5,"ttlMs":15000,"ttlSeconds":15}
2025-01-15 14:32:03 [debug]: Spotify API request {"endpoint":"https://api.spotify.com/v1/search","method":"GET","hasBody":false}
```

**File output**: Structured JSON for parsing and analysis
```json
{"level":"info","message":"Party queue: Track added","trackId":"3n3Ppam7vgaVa1iaRUc9Lp","trackName":"Mr. Brightside","artistName":"The Killers","addedByIP":"192.168.1.42","nickname":"Guest","queueSize":5,"votesCount":0,"timestamp":"2025-01-15T14:30:45.123Z","service":"party-jukebox"}
```

#### Examples of Enhanced Logging

**Queue Operations:**
```json
// Track added to queue
{"level":"info","message":"Party queue: Track added","trackId":"abc123","trackName":"Song Name","artistName":"Artist Name","addedByIP":"192.168.1.10","nickname":"John","queueSize":3,"votesCount":0}

// Vote added
{"level":"info","message":"Party queue: Vote added","trackId":"abc123","trackName":"Song Name","voterIP":"192.168.1.11","action":"add","previousVoteCount":2,"newVoteCount":3}
```

**Token Management:**
```json
// Token validation (verbose)
{"level":"verbose","message":"Token validation","hasAccessToken":true,"expiresAt":"2025-01-15T15:30:00.000Z","timeUntilExpirySeconds":1800,"needsRefresh":false}

// Token refresh attempt (debug)
{"level":"debug","message":"Token refresh attempt","currentToken":"present","expiresAt":"2025-01-15T15:30:00.000Z","timeUntilExpirySeconds":60}
```

**Cache Operations:**
```json
// Cache hit (verbose)
{"level":"verbose","message":"Playback cache hit","cacheAgeMs":3245,"cacheAgeSeconds":3,"ttlMs":15000,"ttlSeconds":15}

// Cache miss (verbose)
{"level":"verbose","message":"Spotify queue cache miss","reason":"expired","cacheAgeMs":16234,"ttlMs":15000}
```

**Spotify API:**
```json
// API request details (debug)
{"level":"debug","message":"Spotify API request","endpoint":"https://api.spotify.com/v1/search","method":"GET","hasBody":false}

// API timing (info)
{"level":"info","message":"Spotify API timing","endpoint":"https://api.spotify.com/v1/search","method":"GET","statusCode":200,"responseTimeMs":245,"retriesUsed":0}
```

**Rate Limiting:**
```json
// Rate limit hit (warn)
{"level":"warn","message":"Rate limit hit","endpoint":"/api/search","method":"GET","clientIP":"192.168.1.50","limit":100,"windowMinutes":15}
```

#### Viewing Logs

```bash
# View recent logs (all levels at your LOG_LEVEL and above)
tail -f logs/jukebox-$(date +%Y-%m-%d).log

# View only errors
tail -f logs/jukebox-error-$(date +%Y-%m-%d).log

# Search for specific events
grep '"level":"error"' logs/jukebox-*.log
grep 'Party queue: Track added' logs/jukebox-*.log
grep 'Token refresh' logs/jukebox-*.log

# Parse JSON logs with jq
cat logs/jukebox-*.log | jq '. | select(.level == "error")'
cat logs/jukebox-*.log | jq '. | select(.message | contains("queue"))'
cat logs/jukebox-*.log | jq '. | select(.clientIP == "192.168.1.10")'

# Count events by type
cat logs/jukebox-*.log | jq -r '.message' | sort | uniq -c | sort -rn

# Monitor cache performance
cat logs/jukebox-*.log | jq '. | select(.message | contains("cache"))'
```

#### Sensitive Data Protection

Logging is designed to protect sensitive information:
- **Tokens**: Never logged in full; only "present" or "missing" indicators at info/warn levels
- **Passwords**: Never logged
- **Partial token previews**: Only first 8 characters + "..." at debug level
- **API keys**: Client ID shown as first 8 chars + "..." at debug level only

At production levels (`info`, `warn`, `error`), no sensitive data is exposed.

### HTTPS/SSL Configuration

Party Jukebox supports secure HTTPS connections for LAN deployments. When both `SSL_CERT_PATH` and `SSL_KEY_PATH` are set, the server runs in HTTPS mode.

#### Generating Certificates with mkcert (Recommended)

[mkcert](https://github.com/FiloSottile/mkcert) is the easiest way to create locally-trusted certificates for your LAN IP:

```bash
# Install mkcert (on macOS with Homebrew)
brew install mkcert
mkcert -install

# Or on Linux
# See: https://github.com/FiloSottile/mkcert#installation

# Create certificates for your LAN IP (replace with your IP)
mkdir -p certs
cd certs
mkcert 192.168.50.159 localhost

# This creates two files:
# - 192.168.50.159+1.pem (certificate)
# - 192.168.50.159+1-key.pem (private key)
```

#### Configuring HTTPS in .env

```bash
# SSL/HTTPS Configuration
SSL_CERT_PATH=./certs/192.168.50.159+1.pem
SSL_KEY_PATH=./certs/192.168.50.159+1-key.pem
SSL_PORT=443
SSL_HOST=192.168.50.159
```

#### Running with HTTPS

Once configured, start the server and access it via HTTPS:

```bash
# Start the server (may require sudo for port 443)
sudo npm start

# Access the app
# https://192.168.50.159/
```

> **Note**: Using port 443 typically requires root/administrator privileges. You can use a higher port (e.g., `SSL_PORT=8443`) to avoid this requirement.

> **Note**: The OAuth callback continues to use the HTTP loopback interface for Spotify authentication. This is normal and secure as it only accepts connections from `127.0.0.1`.

### OAuth Configuration

Party Jukebox supports two OAuth modes:

#### 1. Dynamic Loopback Port (Default - RFC 8252 Compliant)

When `SPOTIFY_REDIRECT_URI` is **not set**, the app uses RFC 8252 compliant OAuth:
- A random available port is selected on `127.0.0.1` when the OAuth flow starts
- The redirect URI is dynamically set to `http://127.0.0.1:{port}/callback`
- This is the recommended mode for desktop/local deployments

**Spotify App Configuration**: Add `http://127.0.0.1/callback` as a Redirect URI in your Spotify app settings. Spotify's OAuth server will accept any port on the loopback interface per RFC 8252.

#### 2. Static Redirect URI (For Server Deployments)

When `SPOTIFY_REDIRECT_URI` **is set**, the app uses a fixed redirect URI:
- Set this for cloud/server deployments where you have a fixed callback URL
- Example: `SPOTIFY_REDIRECT_URI=https://jukebox.example.com/callback`

### LAN Access Setup

For guests to access the jukebox:

1. Ensure your firewall allows connections on the configured port
2. Share your local IP address with guests (e.g., `https://192.168.1.100` or `http://192.168.1.100:3000`)

> **Note**: The OAuth callback always uses the loopback interface (`127.0.0.1`), so guests don't need to be able to reach the OAuth callback port - only the main app port.

## Party Features

### 🎨 Customizable Branding
Personalize the application title and byline for your event:
- Set `APP_TITLE` to customize the main title (e.g., "Brooklyn's JukeBox")
- Set `APP_BYLINE` to add a custom subtitle (e.g., "Ring in the New Year with music")
- Changes are displayed dynamically to all users without code modifications

### 🎵 Spotify Queue Integration
View what's actually queued in Spotify:
- The Queue tab shows both the **Spotify Queue** (actual playback queue) and the **Party Voting Queue** (collaborative suggestions)
- Refresh the Spotify queue on demand to see what's coming up next
- Clear visual distinction between the two queues

### 🗳️ Queue Voting
Guests can upvote songs in the party queue. Songs with more votes appear higher in the party queue display. This helps ensure popular choices get attention!

### 🚫 Track Limits
Each device (by IP) can only add a limited number of tracks (default: 5). This prevents any single guest from dominating the queue. The host can:
- Reset limits via the admin panel to allow users to add more tracks
- **Toggle enforcement on/off** - when disabled, users can add unlimited tracks
- Set `ENFORCE_TRACK_LIMITS=false` in `.env` to start with limits disabled

### ⚙️ Host Admin Panel
Set `ADMIN_PASSWORD` in your `.env` to enable host controls:
- **Skip**: Skip the current track
- **Pause/Play**: Control playback
- **Toggle Limits**: Enable or disable track limit enforcement in real-time
- **Clear Queue**: Remove all tracks from the party voting queue display
- **Reset Limits**: Reset track counts for all guests

## Server Deployment

For running Party Jukebox on a home Linux server, see the `deploy/` folder for:

- **systemd service file** (`jukebox.service`) - Auto-restart on boot
- **PM2 config** (`ecosystem.config.js`) - Process management
- **Nginx config** (`nginx.conf`) - Reverse proxy with HTTPS
- **Caddy config** (`Caddyfile`) - Alternative reverse proxy with auto-HTTPS
- **Docker** (`Dockerfile`, `docker-compose.yml`) - Container deployment

### Quick Deploy with systemd

```bash
# Copy files to server
sudo mkdir -p /opt/jukebox
sudo cp -r . /opt/jukebox/
sudo cp deploy/jukebox.service /etc/systemd/system/

# Create user and set permissions
sudo useradd -r -s /bin/false jukebox
sudo chown -R jukebox:jukebox /opt/jukebox

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable jukebox
sudo systemctl start jukebox
```

### Quick Deploy with PM2

```bash
npm install -g pm2
pm2 start deploy/ecosystem.config.js
pm2 startup  # Follow instructions for auto-start
pm2 save
```

### Quick Deploy with Docker

Docker deployment runs on **HTTPS port 443** by default for secure connections.

```bash
# 1. Generate SSL certificates (using mkcert - recommended)
mkdir -p certs
cd certs
mkcert 192.168.x.x localhost  # Replace with your LAN IP
cd ..

# 2. Create logs and data directories with proper permissions
mkdir -p logs data && sudo chown 1001:1001 logs data
# Or if sudo is unavailable: chmod 775 logs data

# 3. Configure environment
cp .env.example .env
# Edit .env: set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET
# Update SSL_CERT_PATH and SSL_KEY_PATH with your certificate filenames

# 4. Start the container
./scripts/docker-start.sh

# 5. Access the app
# https://192.168.x.x/ (replace with your LAN IP)
```

## Scripts

The `scripts/` directory contains utility scripts for managing the application:

| Script | Description |
|--------|-------------|
| `docker-start.sh` | Build and start the Docker container with all volume mounts (.env, certs, logs, data) |
| `docker-stop.sh` | Stop and remove the Docker container (logs and data are preserved) |
| `update_and_restart.sh` | Pull latest code from git, install dependencies, and restart the systemd service |
| `tag-release.sh` | Interactive tool for creating version tags with semantic versioning |

### Using the Scripts

#### Docker Management
```bash
# Start the container
./scripts/docker-start.sh

# Stop the container
./scripts/docker-stop.sh

# View logs
docker logs -f jukebox

# Or use docker-compose directly
docker-compose up -d    # Start
docker-compose down     # Stop
docker-compose logs -f  # View logs
```

#### Docker Volume Mounts

The Docker scripts automatically mount the following directories:

| Host Path | Container Path | Description |
|-----------|----------------|-------------|
| `./.env` | `/app/.env` | Environment configuration (via --env-file) |
| `./certs/` | `/app/certs/` | SSL certificates (read-only) |
| `./logs/` | `/app/logs/` | Application logs (persistent) |
| `./data/` | `/app/data/` | SQLite database (persistent) |

#### Docker HTTPS Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `SSL_CERT_PATH` | Path to SSL certificate (inside container: `/app/certs/...`) | Required for HTTPS |
| `SSL_KEY_PATH` | Path to SSL private key (inside container: `/app/certs/...`) | Required for HTTPS |
| `SSL_PORT` | HTTPS port | `443` |
| `SSL_HOST` | IP address to bind | `0.0.0.0` |

#### Docker Healthcheck

The Docker healthcheck probes `https://localhost:443/api/status` using wget with `--no-check-certificate` to support self-signed certificates. The `/api/status` endpoint returns:

```json
{
  "status": "ok",
  "authenticated": false,
  "configured": false
}
```

#### Troubleshooting Docker HTTPS

- **Port 443 binding fails**: Port 443 requires root privileges. Either run Docker as root or use a higher port mapping (e.g., `8443:443` in docker-compose.yml)
- **Certificate not found**: Ensure the `certs/` directory contains your certificates and is mounted correctly
- **Healthcheck failing**: Verify SSL_CERT_PATH and SSL_KEY_PATH point to valid certificates inside `/app/certs/`

#### Troubleshooting Docker Logs

The container runs as a non-root user (`jukebox`, UID 1001) for security. Log files are persisted to the host's `./logs` directory via volume mount.

**Log directory permission issues:**

If logs are not being written or you see permission errors:

```bash
# Recommended: Set ownership to match the container user (UID 1001)
mkdir -p logs && sudo chown 1001:1001 logs

# Alternative: Make directory group-writable (less secure)
mkdir -p logs && chmod 775 logs
```

**Common symptoms:**
- Container exits immediately with permission errors
- No log files appearing in `./logs` directory
- Application errors about "EACCES: permission denied"

**Why this happens:**
- When a host directory is mounted into the container, the container user needs write permissions
- The container's `jukebox` user (UID 1001) may not match your host user's UID
- Setting ownership to UID 1001 is the most secure approach
- Using `chmod 775` allows group write access as a fallback

**Using docker-compose:**
```bash
# Before first run (recommended)
mkdir -p logs && sudo chown 1001:1001 logs

# Then start the container
docker-compose up -d
```

**Using docker run directly:**
```bash
# Before first run (recommended)
mkdir -p logs && sudo chown 1001:1001 logs

# Then start with the script
./docker-start.sh
```

### Automated Updates

A Bash script is provided to automate pulling the latest code and restarting the jukebox service.

**Script:** `scripts/update_and_restart.sh`

#### Usage

```bash
# Run the script (requires sudo for service restart)
sudo ./scripts/update_and_restart.sh

# Skip dependency installation if no new dependencies were added
sudo ./scripts/update_and_restart.sh --skip-deps
```

#### What the Script Does

1. **Pulls latest code** from the remote Git repository
2. **Installs npm dependencies** (production only, skipping devDependencies and audit reports - can be skipped with `--skip-deps`)
3. **Updates `LAST_UPDATED.txt`** with the current timestamp (UTC)
4. **Restarts the jukebox systemd service**

> **Note:** The script uses `--no-audit` to speed up installation. Run `npm audit` separately to check for security vulnerabilities.

#### Configuration

Edit the variables at the top of `scripts/update_and_restart.sh` to customize:

| Variable | Description | Default |
|----------|-------------|---------|
| `REPO_DIR` | Path to the jukebox repository | `/opt/jukebox` |
| `SERVICE_NAME` | Name of the systemd service | `jukebox` |

#### Options

| Flag | Description |
|------|-------------|
| `--skip-deps` | Skip npm dependency installation (use when dependencies haven't changed) |

#### Requirements

- **Git** must be installed and configured
- **Node.js and npm** must be installed (for dependency installation)
- **systemd** service must be set up (see `deploy/jukebox.service`)
- Script must be run with sufficient permissions to restart the service (typically via `sudo`)

### Release Management

The `scripts/tag-release.sh` script provides an interactive tool for creating version tags with semantic versioning.

#### Features

- Interactive prompts for version number with validation
- Option to specify release type (major, minor, patch) with auto-increment
- Automatic tag creation with annotation
- Push tags to remote repository
- Generate release notes template
- Comprehensive error handling and confirmation prompts

#### Usage

```bash
# Run the script
./scripts/tag-release.sh
```

The script will:
1. Display the latest tag
2. Prompt you to choose between manual version entry or auto-increment
3. For auto-increment, select major/minor/patch release type
4. Open your editor to write release notes
5. Show a summary and ask for confirmation
6. Create and optionally push the tag to the remote repository

#### Example

```bash
$ ./scripts/tag-release.sh
========================================
Party Jukebox Release Tagging Tool
========================================

ℹ Latest tag: v1.0.0

How would you like to specify the new version?
  1) Enter version number manually
  2) Auto-increment (major, minor, or patch)

Choose an option (1 or 2): 2

Select release type:
  1) Major (breaking changes): v1.0.0 -> v2.0.0
  2) Minor (new features):     v1.0.0 -> v1.1.0
  3) Patch (bug fixes):        v1.0.0 -> v1.0.1

Choose release type (1-3): 2

ℹ New version: v1.1.0

# Editor opens for release notes...

========================================
Release Summary
========================================
Version: v1.1.0
Previous: v1.0.0

Release Notes:
# Release v1.1.0

## New Features
- Added customizable branding
- Spotify queue integration
...

========================================

Create and push this tag? (y/N) y
✓ Tag created successfully.

Push tag to remote? (y/N) y
✓ Tag pushed to remote successfully.

========================================
✓ Release v1.1.0 completed successfully!
========================================
```

#### Example Output

```
========================================
Party Jukebox Update and Restart Script
========================================

[1/4] Navigating to repository directory: /opt/jukebox
      Current directory: /opt/jukebox

[2/4] Pulling latest code from remote repository...
      Code updated successfully.

[3/4] Updating LAST_UPDATED.txt...
      Timestamp written: 2025-01-15 14:30:45 UTC

[4/4] Restarting jukebox service...
      Service restarted successfully.

========================================
Update and restart completed successfully!
========================================
```

### HTTPS Setup

#### Option 1: Let's Encrypt (recommended for public domains)
```bash
# With Caddy (automatic)
# Just point your domain to your server - Caddy handles certificates

# With Nginx + Certbot
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d jukebox.yourdomain.com
```

#### Option 2: Self-Signed Certificate (for local network)
```bash
# Generate certificate
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/ssl/private/jukebox.key \
  -out /etc/ssl/certs/jukebox.crt \
  -subj "/CN=jukebox.local"
```

### Restricting Access (Security)

#### Firewall (UFW)
```bash
# Only allow local network
sudo ufw allow from 192.168.1.0/24 to any port 3000
sudo ufw deny 3000
```

#### Nginx IP Whitelist
Add to your nginx.conf server block:
```nginx
allow 192.168.1.0/24;
deny all;
```

#### iptables
```bash
# Only allow local subnet
sudo iptables -A INPUT -p tcp --dport 3000 -s 192.168.1.0/24 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 3000 -j DROP
```

## API Endpoints

### Public Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Main web interface |
| `/analytics.html` | GET | Analytics dashboard |
| `/login` | GET | Initiates Spotify OAuth |
| `/callback` | GET | OAuth callback handler |
| `/api/status` | GET | Check authentication status |
| `/api/config` | GET | Get app configuration (title, byline, limits) |
| `/api/qrcode` | GET | Generate QR code for URL sharing |
| `/api/search?q=` | GET | Search for tracks |
| `/api/queue` | POST | Add track to queue |
| `/api/party-queue` | GET | Get party queue with votes |
| `/api/vote/:trackId` | POST | Vote/unvote for a track |
| `/api/track-limit` | GET | Get remaining tracks for current user |
| `/api/playback` | GET | Get current playback state |
| `/api/spotify-queue` | GET | Get Spotify's actual queue (requires auth) |
| `/api/logout` | POST | Clear authentication |

### Admin Endpoints (require `Authorization: Bearer <ADMIN_PASSWORD>`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/status` | GET | Check if admin is configured |
| `/api/admin/login` | POST | Verify admin credentials |
| `/api/admin/skip` | POST | Skip current track |
| `/api/admin/pause` | POST | Pause playback |
| `/api/admin/play` | POST | Resume playback |
| `/api/admin/queue` | DELETE | Clear party queue |
| `/api/admin/queue/:trackId` | DELETE | Remove specific track |
| `/api/admin/reset-limits` | POST | Reset all track limits |
| `/api/admin/toggle-limits` | POST | Enable/disable track limit enforcement |
| `/api/admin/track-limits` | GET | Get all IP track counts |

### Analytics Endpoints

Party Jukebox provides built-in analytics to track party activity and engagement. All analytics endpoints are public and don't require authentication.

| Endpoint | Method | Description | Query Parameters |
|----------|--------|-------------|------------------|
| `/api/analytics/top-tracks` | GET | Get most requested tracks across all time | `?limit=10` (default: 10) |
| `/api/analytics/top-users` | GET | Get most active users by track submission count | `?limit=10` (default: 10) |
| `/api/analytics/stats` | GET | Get overall party statistics | None |
| `/api/analytics/peak-hours` | GET | Get peak usage by hour of day | None |
| `/api/analytics/user/:ip` | GET | Get statistics for specific user by IP | None |

#### Analytics Data

Analytics are calculated from:
- **Party queue submissions**: Current and historical tracks added to the queue
- **Vote activity**: All votes cast on tracks
- **User session data**: Track counts and nicknames per IP
- **Playback history**: Records of tracks that have been played

All analytics respect data persistence across server restarts.

#### Example Responses

**GET /api/analytics/top-tracks**
```json
{
  "tracks": [
    {
      "trackId": "3n3Ppam7vgaVa1iaRUc9Lp",
      "name": "Mr. Brightside",
      "artist": "The Killers",
      "albumArt": "https://...",
      "spotifyUri": "spotify:track:3n3Ppam7vgaVa1iaRUc9Lp",
      "requestCount": 15
    }
  ]
}
```

**GET /api/analytics/top-users**
```json
{
  "users": [
    {
      "ipAddress": "192.168.1.50",
      "nickname": "DJ Mike",
      "trackCount": 12
    }
  ]
}
```

**GET /api/analytics/stats**
```json
{
  "totalTracksInQueue": 42,
  "totalUsers": 8,
  "totalVotes": 127,
  "totalTracksPlayed": 35,
  "mostVotedTrack": {
    "trackId": "3n3Ppam7vgaVa1iaRUc9Lp",
    "name": "Mr. Brightside",
    "artist": "The Killers",
    "votes": 23
  }
}
```

**GET /api/analytics/peak-hours**
```json
{
  "hourlyStats": [
    { "hour": 14, "trackCount": 25 },
    { "hour": 20, "trackCount": 48 },
    { "hour": 21, "trackCount": 62 }
  ]
}
```

**GET /api/analytics/user/192.168.1.50**
```json
{
  "ipAddress": "192.168.1.50",
  "nickname": "DJ Mike",
  "totalTracksAdded": 12,
  "totalVotesCast": 8,
  "currentTracksInQueue": 3,
  "lastActive": 1703012345678
}
```

#### Using Analytics

Analytics can be used to:
- **Track party engagement**: See how many tracks and votes over time
- **Identify popular songs**: Find crowd favorites to play more often
- **Recognize active participants**: See who's contributing most
- **Optimize timing**: Understand peak party hours
- **Monitor activity**: Track overall party statistics in real-time

Analytics data is stored persistently in the SQLite database and survives server restarts.

## Security Best Practices

1. **Use HTTPS**: Always use HTTPS in production, especially on public networks
2. **Set Admin Password**: Enable admin controls with a strong password
3. **Restrict Network Access**: Use firewall rules to limit access to your local network
4. **Keep Node.js Updated**: Regularly update Node.js and dependencies
5. **Monitor Logs**: Check logs for suspicious activity
6. **Don't Expose to Internet**: This app is designed for local network use

## Troubleshooting

### "No active device found"
Make sure you have Spotify playing on a device. The API can only add to queue when there's an active playback session.

### OAuth redirect_uri mismatch error
This error occurs when the redirect URI used by the app doesn't match what's configured in your Spotify app settings.

**For Dynamic Port Mode (default)**:
- Ensure `http://127.0.0.1/callback` is added as a Redirect URI in your Spotify app settings
- Do NOT include a port number - Spotify will accept any port per RFC 8252
- Make sure `SPOTIFY_REDIRECT_URI` is NOT set in your `.env` file

**For Static URI Mode**:
- Ensure the exact URI (including port) matches in both your Spotify app and `.env` file
- Example: If using `http://localhost:3000/callback`, it must match exactly in both places

### OAuth callback server failed to start
- Ensure no firewall is blocking outbound connections on random ports
- Check that the loopback interface (127.0.0.1) is available
- Try restarting the app

### Guests can't connect
- Check your firewall allows connections on the port
- Verify guests are on the same network
- Try using the direct IP address instead of hostname
- Check if the QR code URL matches your network configuration

### Token refresh issues
Tokens automatically refresh. If issues persist, click "Disconnect" and reconnect.

### Track limit reached
Guests can only add a limited number of tracks. The host can reset limits from the admin panel.

## Tech Stack

- **Backend**: Node.js with Express
- **Database**: SQLite with better-sqlite3
- **Frontend**: Vanilla HTML/CSS/JavaScript
- **API**: Spotify Web API
- **Auth**: OAuth 2.0 with refresh tokens
- **QR Code**: qrcode library
- **Logging**: Winston (structured logs) + Morgan (HTTP request logging)

## License

MIT
