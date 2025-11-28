# 🎵 Party Jukebox

A lightweight web application that allows guests on your local network to search Spotify for songs and add them to your playback queue. Perfect for parties, gatherings, or any event where you want collaborative music selection!

## Features

- **Simple Setup**: Just configure your Spotify credentials and run
- **LAN-Friendly**: Guests connect via your local network IP
- **Mobile-Optimized**: Responsive design works great on phones
- **Real-Time**: Shows currently playing track
- **Secure**: Only the host needs a Spotify account; guests just search and add

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
   - Redirect URI: `http://localhost:3000/callback`
4. Save your **Client ID** and **Client Secret**

### 2. Configure Environment

```bash
# Copy the example environment file
cp .env.example .env

# Edit .env with your credentials
# SPOTIFY_CLIENT_ID=your_client_id_here
# SPOTIFY_CLIENT_SECRET=your_client_secret_here
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

Find your local IP address and share `http://<your-ip>:3000` with guests.

```bash
# On Linux/Mac
ip addr | grep inet
# or
ifconfig | grep inet

# On Windows
ipconfig
```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `SPOTIFY_CLIENT_ID` | Your Spotify app's Client ID | Required |
| `SPOTIFY_CLIENT_SECRET` | Your Spotify app's Client Secret | Required |
| `SPOTIFY_REDIRECT_URI` | OAuth callback URL | `http://localhost:3000/callback` |
| `PORT` | Server port | `3000` |

### LAN Access Setup

For guests to access the jukebox:

1. Update your Spotify app's Redirect URI to use your local IP (e.g., `http://192.168.1.100:3000/callback`)
2. Set `SPOTIFY_REDIRECT_URI` in your `.env` to match
3. Ensure your firewall allows connections on the configured port

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Main web interface |
| `/login` | GET | Initiates Spotify OAuth |
| `/callback` | GET | OAuth callback handler |
| `/api/status` | GET | Check authentication status |
| `/api/search?q=` | GET | Search for tracks |
| `/api/queue` | POST | Add track to queue (body: `{uri}`) |
| `/api/playback` | GET | Get current playback state |
| `/api/logout` | POST | Clear authentication |

## Troubleshooting

### "No active device found"
Make sure you have Spotify playing on a device. The API can only add to queue when there's an active playback session.

### Guests can't connect
- Check your firewall allows connections on the port
- Verify guests are on the same network
- Try using the direct IP address instead of hostname

### Token refresh issues
Tokens automatically refresh. If issues persist, click "Disconnect" and reconnect.

## Tech Stack

- **Backend**: Node.js with Express
- **Frontend**: Vanilla HTML/CSS/JavaScript
- **API**: Spotify Web API
- **Auth**: OAuth 2.0 with refresh tokens

## License

MIT
