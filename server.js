require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Rate limiting configuration
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 auth attempts per windowMs
  message: { error: 'Too many authentication attempts, please try again later.' }
});

// In-memory storage for tokens (in production, use a proper session store)
let tokenData = {
  accessToken: null,
  refreshToken: null,
  expiresAt: null
};

// Spotify configuration
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || `http://localhost:${PORT}/callback`;

// Middleware
app.use(express.json());
app.use(generalLimiter);
app.use(express.static(path.join(__dirname, 'public')));

// Helper function to make Spotify API requests
async function spotifyFetch(endpoint, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `https://api.spotify.com/v1${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${tokenData.accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });
  return response;
}

// Check if host is authenticated
function isAuthenticated() {
  return tokenData.accessToken && tokenData.expiresAt && Date.now() < tokenData.expiresAt;
}

// Refresh access token
async function refreshAccessToken() {
  if (!tokenData.refreshToken) {
    return false;
  }

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64')
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokenData.refreshToken
      })
    });

    if (!response.ok) {
      return false;
    }

    const data = await response.json();
    tokenData.accessToken = data.access_token;
    tokenData.expiresAt = Date.now() + (data.expires_in * 1000);
    if (data.refresh_token) {
      tokenData.refreshToken = data.refresh_token;
    }
    return true;
  } catch (error) {
    console.error('Error refreshing token:', error);
    return false;
  }
}

// Middleware to ensure token is valid
async function ensureToken(req, res, next) {
  if (!tokenData.accessToken) {
    return res.status(401).json({ error: 'Host not authenticated. Please authenticate first.' });
  }

  // Refresh token if expired or about to expire (within 5 minutes)
  if (Date.now() >= tokenData.expiresAt - 300000) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      tokenData = { accessToken: null, refreshToken: null, expiresAt: null };
      return res.status(401).json({ error: 'Session expired. Please re-authenticate.' });
    }
  }

  next();
}

// Routes

// Check authentication status
app.get('/api/status', (req, res) => {
  res.json({
    authenticated: isAuthenticated(),
    configured: !!(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET)
  });
});

// Spotify OAuth login
app.get('/login', authLimiter, (req, res) => {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    return res.status(500).send('Spotify credentials not configured. Please set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables.');
  }

  const state = crypto.randomBytes(16).toString('hex');
  const scope = 'user-read-playback-state user-modify-playback-state';

  const authUrl = new URL('https://accounts.spotify.com/authorize');
  authUrl.searchParams.append('response_type', 'code');
  authUrl.searchParams.append('client_id', SPOTIFY_CLIENT_ID);
  authUrl.searchParams.append('scope', scope);
  authUrl.searchParams.append('redirect_uri', SPOTIFY_REDIRECT_URI);
  authUrl.searchParams.append('state', state);

  res.redirect(authUrl.toString());
});

// Spotify OAuth callback
app.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.redirect('/?error=' + encodeURIComponent(error));
  }

  if (!code) {
    return res.redirect('/?error=no_code');
  }

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64')
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: SPOTIFY_REDIRECT_URI
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Token exchange error:', errorData);
      return res.redirect('/?error=token_exchange_failed');
    }

    const data = await response.json();
    tokenData.accessToken = data.access_token;
    tokenData.refreshToken = data.refresh_token;
    tokenData.expiresAt = Date.now() + (data.expires_in * 1000);

    res.redirect('/?authenticated=true');
  } catch (err) {
    console.error('Callback error:', err);
    res.redirect('/?error=callback_failed');
  }
});

// Search for tracks
app.get('/api/search', ensureToken, async (req, res) => {
  const { q } = req.query;

  if (!q || q.trim() === '') {
    return res.status(400).json({ error: 'Search query is required' });
  }

  try {
    const response = await spotifyFetch(`/search?type=track&limit=20&q=${encodeURIComponent(q)}`);

    if (!response.ok) {
      const errorData = await response.json();
      return res.status(response.status).json({ error: errorData.error?.message || 'Search failed' });
    }

    const data = await response.json();
    const tracks = data.tracks.items.map(track => ({
      id: track.id,
      uri: track.uri,
      name: track.name,
      artist: track.artists.map(a => a.name).join(', '),
      album: track.album.name,
      albumArt: track.album.images[0]?.url || null,
      duration: track.duration_ms
    }));

    res.json({ tracks });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Failed to search tracks' });
  }
});

// Add track to queue
app.post('/api/queue', ensureToken, async (req, res) => {
  const { uri } = req.body;

  if (!uri) {
    return res.status(400).json({ error: 'Track URI is required' });
  }

  try {
    const response = await spotifyFetch(`/me/player/queue?uri=${encodeURIComponent(uri)}`, {
      method: 'POST'
    });

    if (response.status === 204) {
      return res.json({ success: true, message: 'Track added to queue' });
    }

    if (response.status === 404) {
      return res.status(404).json({ error: 'No active device found. Please start playing on Spotify first.' });
    }

    const errorData = await response.json();
    return res.status(response.status).json({ error: errorData.error?.message || 'Failed to add to queue' });
  } catch (err) {
    console.error('Queue error:', err);
    res.status(500).json({ error: 'Failed to add track to queue' });
  }
});

// Get current playback state
app.get('/api/playback', ensureToken, async (req, res) => {
  try {
    const response = await spotifyFetch('/me/player');

    if (response.status === 204) {
      return res.json({ playing: false, device: null });
    }

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to get playback state' });
    }

    const data = await response.json();
    res.json({
      playing: data.is_playing,
      device: data.device?.name || null,
      track: data.item ? {
        name: data.item.name,
        artist: data.item.artists.map(a => a.name).join(', '),
        albumArt: data.item.album.images[0]?.url || null
      } : null
    });
  } catch (err) {
    console.error('Playback error:', err);
    res.status(500).json({ error: 'Failed to get playback state' });
  }
});

// Logout (clear tokens)
app.post('/api/logout', (req, res) => {
  tokenData = { accessToken: null, refreshToken: null, expiresAt: null };
  res.json({ success: true });
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 Party Jukebox running at http://localhost:${PORT}`);
  console.log(`   LAN access: http://<your-local-ip>:${PORT}`);
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    console.log('\n⚠️  Warning: Spotify credentials not configured!');
    console.log('   Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables.');
  }
});
