# Copilot Instructions for Jukebox

This repository contains the Party Jukebox application - a lightweight web application that allows guests on a local network to search Spotify for songs and add them to a host's playback queue.

## Project Overview

Party Jukebox is a Node.js/Express web application that provides a collaborative music queueing system for parties and gatherings. Key features include:
- Spotify API integration for search and playback control
- OAuth 2.0 authentication (RFC 8252 compliant with dynamic loopback ports)
- Real-time queue management with voting system
- Admin controls for host (skip, pause/play, queue management)
- Per-IP track limits to prevent queue flooding
- QR code generation for easy mobile access
- HTTPS/SSL support for secure connections
- Structured logging with Winston and Morgan
- SQLite database for persistent queue state and analytics

## Technology Stack

- **Backend**: Node.js (>=18.0.0) with Express 5.x
- **Database**: SQLite with better-sqlite3 (WAL mode)
- **Frontend**: Vanilla HTML/CSS/JavaScript (no framework)
- **API**: Spotify Web API (OAuth 2.0)
- **Logging**: Winston (structured JSON logs) + Morgan (HTTP request logging)
- **Security**: express-rate-limit for API protection
- **Other**: QRCode generation, dotenv for configuration

## Project Structure

```
/
├── server.js              # Main Express server and API endpoints
├── database.js            # SQLite database layer (camelCase schema)
├── database.test.js       # Database unit tests
├── server.test.js         # Server integration tests
├── logger.js              # Winston/Morgan logging configuration
├── package.json           # Dependencies and scripts
├── .env.example           # Environment variable template
├── data/                  # SQLite database files (auto-created)
│   └── jukebox.db         # Main database file
├── public/
│   ├── index.html         # Single-page web interface
│   └── analytics.html     # Analytics dashboard
├── scripts/               # Utility scripts
│   ├── docker-start.sh    # Start Docker container
│   ├── docker-stop.sh     # Stop Docker container
│   ├── update_and_restart.sh  # Update code and restart service
│   └── tag-release.sh     # Create version tags with semantic versioning
├── deploy/                # Deployment configurations
│   ├── jukebox.service    # systemd service file
│   ├── ecosystem.config.js # PM2 configuration
│   ├── nginx.conf         # Nginx reverse proxy
│   └── Caddyfile          # Caddy reverse proxy
├── Dockerfile             # Docker container setup
├── docker-compose.yml     # Docker Compose configuration
└── logs/                  # Rotating log files (auto-created)
```

## Development Workflow

### Setup

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your Spotify credentials

# Run the server
npm start

# Run tests (server and database)
npm test
```

### Environment Variables

Required:
- `SPOTIFY_CLIENT_ID` - Your Spotify app Client ID
- `SPOTIFY_CLIENT_SECRET` - Your Spotify app Client Secret

Optional:
- `PORT` (default: 3000) - HTTP server port
- `APP_TITLE` (default: "Party JukeBox") - Application title
- `APP_BYLINE` (default: "Your collaborative music queue") - Subtitle/tagline
- `MAX_TRACKS_PER_IP` (default: 5) - Track limit per device
- `ENFORCE_TRACK_LIMITS` (default: true) - Enable/disable track limit enforcement
- `ADMIN_PASSWORD` - Enable host admin controls
- `SSL_CERT_PATH` / `SSL_KEY_PATH` - HTTPS certificate paths
- `SSL_PORT` (default: 443) / `SSL_HOST` (default: 0.0.0.0) - HTTPS config
- `LOG_LEVEL` (default: info) - Logging verbosity
- `SPOTIFY_REDIRECT_URI` - Static OAuth redirect (optional, for server deployments)
- `DATABASE_PATH` (default: ./data/jukebox.db) - SQLite database location
- `ADMIN_SESSION_EXPIRY` (default: 86400) - Admin session expiry in seconds

## Architecture: Key Patterns

### Database Layer (database.js)
The app uses SQLite with **camelCase naming** (migrated from snake_case). The database provides:
- **Synchronous operations** via better-sqlite3 (simpler error handling)
- **WAL mode** for better concurrency (separate read/write operations)
- **Automatic schema migration** from old snake_case tables on first run
- **UNIQUE constraints** prevent duplicate tracks from same user: `UNIQUE(trackId, addedByIp)`

Key database patterns:
```javascript
// Database operations are synchronous - no async/await needed
db.addToPartyQueue(track);  // Returns boolean, throws on error
const queue = db.getPartyQueue();  // Always returns array

// All DB operations auto-log via logger module
// Database handles cleanup on server shutdown
```

Tables use camelCase: `partyQueue`, `trackVotes`, `userSessions`, `playbackHistory`, `adminSessions`

### Caching Strategy (server.js)
Critical caches reduce Spotify API load:
- **playbackCache**: Current playback state, 15s TTL (avoids rate limits)
- **spotifyQueueCache**: Spotify's actual queue, 15s TTL (expensive API call)
- **tokenData**: In-memory OAuth tokens (access/refresh, expiry tracking)

Tokens auto-refresh when `tokenData.expiresAt - Date.now() < TOKEN_REFRESH_BUFFER_MS` (5 min buffer)

### IP-Based User Identity
No user accounts - identity tracked via `getClientIP(req)`:
```javascript
// Respects X-Forwarded-For (proxy-aware), falls back to socket
const clientIP = getClientIP(req);
```
Used for: track limits (`userSessions`), voting, analytics, admin sessions

### Spotify API Integration
- **spotifyFetch()**: Wrapper with retry logic (exponential backoff), timeout (10s), status-based retries (429, 5xx)
- **parseSpotifyErrorResponse()**: Handles non-JSON error responses from Spotify
- Always await refreshAccessToken() before critical operations

## Code Style and Conventions

- **Async/Await**: Prefer async/await over callbacks for asynchronous operations
- **Error Handling**: Always include try-catch blocks for async operations and Spotify API calls
- **Logging**: Use the `logger` module for all logging (not console.log)
  - `logger.info()` for general information
  - `logger.error()` for errors with context
  - `logger.http()` is handled automatically by Morgan
- **Constants**: Define time-based constants in milliseconds at the top of server.js
- **Rate Limiting**: Apply appropriate rate limiters to API endpoints
- **Comments**: Add comments for complex OAuth flows, Spotify API interactions, and business logic
- **No Frameworks**: Frontend uses vanilla JavaScript - avoid introducing dependencies

## API Endpoints

### Public Endpoints
- `GET /` - Main web interface
- `GET /login` - Initiates Spotify OAuth flow
- `GET /callback` - OAuth callback handler
- `GET /api/status` - Authentication status check
- `GET /api/config` - Get app configuration (title, byline, limits)
- `GET /api/search?q=<query>` - Search Spotify tracks
- `POST /api/queue` - Add track to queue (rate limited, respects ENFORCE_TRACK_LIMITS)
- `GET /api/party-queue` - Get queue with vote counts
- `POST /api/vote/:trackId` - Upvote/downvote track
- `GET /api/track-limit` - Get remaining track count for IP
- `GET /api/playback` - Get current playback state
- `GET /api/spotify-queue` - Get Spotify's actual queue (requires auth, 15s cache)
- `GET /api/qrcode` - Generate QR code for sharing
- `POST /api/logout` - Clear authentication tokens

### Admin Endpoints (require Bearer token)
- `GET /api/admin/status` - Check admin configuration
- `POST /api/admin/login` - Authenticate admin
- `POST /api/admin/skip` - Skip current track
- `POST /api/admin/pause` - Pause playback
- `POST /api/admin/play` - Resume playback
- `DELETE /api/admin/queue` - Clear entire queue
- `DELETE /api/admin/queue/:trackId` - Remove specific track
- `POST /api/admin/reset-limits` - Reset all IP track limits
- `POST /api/admin/toggle-limits` - Enable/disable track limit enforcement
- `GET /api/admin/track-limits` - View all IP track counts

## Testing

- **Framework**: Node.js built-in test runner (`node --test`)
- **Test Files**: `server.test.js` (integration), `database.test.js` (unit)
- **Run Tests**: `npm test` (runs both test files)
- **Test Environment**: 
  - Server tests use PORT 3001, mocked Spotify credentials
  - Database tests use `./data/test-jukebox.db` (auto-cleaned)
- **Patterns**: 
  - Use `describe()` for test suites
  - Use `it()` for individual test cases
  - Use `before()`/`after()` for setup/teardown
  - Use `makeRequest()` helper for HTTP requests (server.test.js)
- **Important**: Ensure existing tests pass before submitting changes
- Write integration tests for new API endpoints
- Database tests verify camelCase schema and UNIQUE constraints

## Common Development Tasks

### Adding a New API Endpoint

1. Add rate limiting if needed (use `generalLimiter` or create specific limiter)
2. Define endpoint in server.js with proper error handling
3. Add logger statements for important operations
4. Update this documentation with endpoint details
5. Add test coverage in server.test.js
6. Update README.md if it's a user-facing feature

### Working with Spotify API

- Always check `tokenData.accessToken` before making requests
- Use `refreshAccessToken()` when tokens expire (automatically handled)
- Include proper Authorization headers: `Bearer ${tokenData.accessToken}`
- Handle Spotify API errors gracefully (404, 401, 429, etc.)
- Log Spotify API interactions with context

### Implementing Security Features

- Apply rate limiting to prevent abuse
- Validate user input before processing
- Use IP-based tracking for features (available via `req.ip`)
- Check ADMIN_PASSWORD for admin endpoints
- Never log sensitive data (tokens, passwords)

### Logging Best Practices

```javascript
// Good logging examples
logger.info('User added track to queue', { trackId, ip: req.ip, trackName });
logger.error('Spotify API error', { error: err.message, endpoint: '/me/player/queue' });
logger.warn('Track limit reached', { ip: req.ip, currentCount: ipTrackCount[ip] });

// Avoid console.log - use logger instead
```

## OAuth Flow

The application supports two OAuth modes:

### Dynamic Loopback (Default)
- Used when `SPOTIFY_REDIRECT_URI` is not set
- Dynamically selects available port on 127.0.0.1
- RFC 8252 compliant for desktop apps
- Redirect URI: `http://127.0.0.1:{random_port}/callback`

### Static Redirect URI
- Used when `SPOTIFY_REDIRECT_URI` is set
- For server/cloud deployments with fixed callback URL
- Redirect URI must match Spotify app settings exactly

## Deployment

- **systemd**: Use `deploy/jukebox.service` for Linux servers
- **PM2**: Use `deploy/ecosystem.config.js` for process management
- **Docker**: Use `Dockerfile` and `docker-compose.yml` for containerization
- **Reverse Proxy**: Nginx (`deploy/nginx.conf`) or Caddy (`deploy/Caddyfile`)
- **HTTPS**: Configure SSL_CERT_PATH and SSL_KEY_PATH for secure connections

## Security Considerations

- Never commit `.env` file or secrets to repository
- Use strong `ADMIN_PASSWORD` in production
- Restrict network access to local network only (firewall rules)
- Keep Node.js and dependencies updated
- Monitor logs for suspicious activity
- Use HTTPS in production environments
- Apply rate limiting to all public endpoints

## Documentation

- Update README.md when adding user-facing features or changing configuration
- Update this file when changing development workflows or architecture
- Document all environment variables in .env.example
- Keep API endpoint documentation current in both README.md and this file

## Pull Requests

- Keep changes focused and minimal
- Write clear, descriptive commit messages
- Ensure all tests pass (`npm test`)
- Test manually with actual Spotify account when possible
- Update documentation for any API or configuration changes
- Include security considerations for new features
- Add appropriate logging for new functionality
