# 🎵 Party Jukebox

A lightweight web application that allows guests on your local network to search Spotify for songs and add them to your playback queue. Perfect for parties, gatherings, or any event where you want collaborative music selection!

## Features

- **Simple Setup**: Just configure your Spotify credentials and run
- **LAN-Friendly**: Guests connect via your local network IP
- **Mobile-Optimized**: Fully responsive design works great on phones and tablets
- **Real-Time**: Shows currently playing track
- **Secure**: Only the host needs a Spotify account; guests just search and add
- **QR Code Sharing**: Generate QR codes for guests to easily join on mobile
- **Queue Voting**: Users can upvote songs to influence play order
- **Track Limits**: Prevent queue flooding with per-device track limits
- **Host Admin Panel**: Skip tracks, pause/play, clear queue, and reset limits
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
| `MAX_TRACKS_PER_IP` | Maximum tracks a device can queue | `5` |
| `ADMIN_PASSWORD` | Password for host admin controls | Empty (disabled) |
| `SSL_CERT_PATH` | Path to SSL certificate file | Empty (disabled) |
| `SSL_KEY_PATH` | Path to SSL private key file | Empty (disabled) |
| `SSL_PORT` | HTTPS server port | `443` |
| `SSL_HOST` | IP address/hostname to bind for HTTPS | `0.0.0.0` |

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

### 🗳️ Queue Voting
Guests can upvote songs in the queue. Songs with more votes appear higher in the party queue display. This helps ensure popular choices get attention!

### 🚫 Track Limits
Each device (by IP) can only add a limited number of tracks (default: 5). This prevents any single guest from dominating the queue. The host can reset limits via the admin panel.

### ⚙️ Host Admin Panel
Set `ADMIN_PASSWORD` in your `.env` to enable host controls:
- **Skip**: Skip the current track
- **Pause/Play**: Control playback
- **Clear Queue**: Remove all tracks from the party queue
- **Reset Limits**: Reset track limits for all guests

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

```bash
docker-compose up -d
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
| `/login` | GET | Initiates Spotify OAuth |
| `/callback` | GET | OAuth callback handler |
| `/api/status` | GET | Check authentication status |
| `/api/qrcode` | GET | Generate QR code for URL sharing |
| `/api/search?q=` | GET | Search for tracks |
| `/api/queue` | POST | Add track to queue |
| `/api/party-queue` | GET | Get party queue with votes |
| `/api/vote/:trackId` | POST | Vote/unvote for a track |
| `/api/track-limit` | GET | Get remaining tracks for current user |
| `/api/playback` | GET | Get current playback state |
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
| `/api/admin/track-limits` | GET | Get all IP track counts |

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
- **Frontend**: Vanilla HTML/CSS/JavaScript
- **API**: Spotify Web API
- **Auth**: OAuth 2.0 with refresh tokens
- **QR Code**: qrcode library

## License

MIT
