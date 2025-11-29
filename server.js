require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

// SSL/HTTPS configuration
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || '';
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || '';
const SSL_PORT = parseInt(process.env.SSL_PORT, 10) || 443;
const SSL_HOST = process.env.SSL_HOST || '0.0.0.0';
const USE_HTTPS = !!(SSL_CERT_PATH && SSL_KEY_PATH);

// Validate SSL configuration
if (USE_HTTPS) {
  if (!fs.existsSync(SSL_CERT_PATH)) {
    console.error(`❌ SSL certificate file not found: ${SSL_CERT_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(SSL_KEY_PATH)) {
    console.error(`❌ SSL key file not found: ${SSL_KEY_PATH}`);
    process.exit(1);
  }
}

// Party configuration
const MAX_TRACKS_PER_IP = parseInt(process.env.MAX_TRACKS_PER_IP, 10) || 5;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

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

// Party queue with voting system
let partyQueue = [];
// Track submissions per IP: { ip: count }
let ipTrackCount = {};
// Votes per track: { trackId: Set of IP addresses }
let trackVotes = {};
// Admin session tokens (simple session management)
let adminSessions = new Set();

// Spotify configuration
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// OAuth loopback configuration (RFC 8252 compliant)
// If SPOTIFY_REDIRECT_URI is set, use it (for server/cloud deployments)
// Otherwise, use dynamic loopback port selection for desktop apps
const USE_DYNAMIC_OAUTH_PORT = !process.env.SPOTIFY_REDIRECT_URI;
let oauthCallbackServer = null;
let oauthCallbackPort = null;
let currentOAuthState = null;

// Get the base URL for the main application server
function getMainAppBaseUrl() {
  // OAuth callback always uses the loopback interface, not the SSL host
  return `http://127.0.0.1:${PORT}`;
}

// Get the OAuth redirect URI (dynamic for desktop, static for server deployments)
function getSpotifyRedirectUri() {
  if (!USE_DYNAMIC_OAUTH_PORT) {
    return process.env.SPOTIFY_REDIRECT_URI;
  }
  if (oauthCallbackPort) {
    return `http://127.0.0.1:${oauthCallbackPort}/callback`;
  }
  return null;
}

// Start the OAuth callback server on a random available port (RFC 8252)
async function startOAuthCallbackServer() {
  return new Promise((resolve, reject) => {
    const callbackApp = express();
    const mainAppUrl = getMainAppBaseUrl();
    
    callbackApp.get('/callback', async (req, res) => {
      const { code, error, state } = req.query;

      // Verify state to prevent CSRF attacks
      if (state !== currentOAuthState) {
        res.status(400).send('Invalid OAuth state. Please try again.');
        return;
      }

      if (error) {
        res.redirect(`${mainAppUrl}/?error=${encodeURIComponent(error)}`);
        return;
      }

      if (!code) {
        res.redirect(`${mainAppUrl}/?error=no_code`);
        return;
      }

      try {
        const redirectUri = getSpotifyRedirectUri();
        const response = await fetch('https://accounts.spotify.com/api/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64')
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: redirectUri
          })
        });

        if (!response.ok) {
          const errorData = await response.json();
          console.error('Token exchange error:', errorData);
          res.redirect(`${mainAppUrl}/?error=token_exchange_failed`);
          return;
        }

        const data = await response.json();
        tokenData.accessToken = data.access_token;
        tokenData.refreshToken = data.refresh_token;
        tokenData.expiresAt = Date.now() + (data.expires_in * 1000);

        // Redirect to main app with success
        res.redirect(`${mainAppUrl}/?authenticated=true`);
      } catch (err) {
        console.error('Callback error:', err);
        res.redirect(`${mainAppUrl}/?error=callback_failed`);
      }
    });

    // Bind to 127.0.0.1 (loopback) on port 0 to get a random available port
    oauthCallbackServer = callbackApp.listen(0, '127.0.0.1', () => {
      oauthCallbackPort = oauthCallbackServer.address().port;
      console.log(`🔐 OAuth callback server listening on http://127.0.0.1:${oauthCallbackPort}/callback`);
      resolve(oauthCallbackPort);
    });

    oauthCallbackServer.on('error', (err) => {
      console.error('Failed to start OAuth callback server:', err);
      reject(new Error(`Failed to start OAuth callback server: ${err.message}`));
    });
  });
}

// Stop the OAuth callback server
function stopOAuthCallbackServer() {
  if (oauthCallbackServer) {
    oauthCallbackServer.close();
    oauthCallbackServer = null;
    oauthCallbackPort = null;
    console.log('🔐 OAuth callback server stopped');
  }
}

// Get client IP address
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.headers['x-real-ip'] ||
         req.connection?.remoteAddress ||
         req.socket?.remoteAddress ||
         'unknown';
}

// Generate admin session token
function generateAdminToken() {
  return crypto.randomBytes(32).toString('hex');
}

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

// Generate QR code for sharing the app URL
app.get('/api/qrcode', async (req, res) => {
  try {
    // Determine the URL to encode
    let url = req.query.url;
    if (!url) {
      // Auto-detect the URL from the request
      const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      url = `${protocol}://${host}`;
    }
    
    const qrDataUrl = await QRCode.toDataURL(url, {
      width: 256,
      margin: 2,
      color: {
        dark: '#1DB954',  // Spotify green
        light: '#1a1a2e'  // Dark background
      }
    });
    
    res.json({ qrcode: qrDataUrl, url });
  } catch (err) {
    console.error('QR code generation error:', err);
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Spotify OAuth login
app.get('/login', authLimiter, async (req, res) => {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    return res.status(500).send('Spotify credentials not configured. Please set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables.');
  }

  try {
    let redirectUri;
    
    if (USE_DYNAMIC_OAUTH_PORT) {
      // Start OAuth callback server on dynamic port (RFC 8252 compliant)
      if (!oauthCallbackServer) {
        await startOAuthCallbackServer();
      }
      redirectUri = getSpotifyRedirectUri();
      
      if (!redirectUri) {
        return res.status(500).send('Failed to start OAuth callback server. Unable to allocate a free port on the loopback interface.');
      }
    } else {
      redirectUri = process.env.SPOTIFY_REDIRECT_URI;
    }

    const state = crypto.randomBytes(16).toString('hex');
    currentOAuthState = state;
    const scope = 'user-read-playback-state user-modify-playback-state';

    const authUrl = new URL('https://accounts.spotify.com/authorize');
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('client_id', SPOTIFY_CLIENT_ID);
    authUrl.searchParams.append('scope', scope);
    authUrl.searchParams.append('redirect_uri', redirectUri);
    authUrl.searchParams.append('state', state);

    console.log(`🔐 Starting OAuth flow with redirect URI: ${redirectUri}`);
    res.redirect(authUrl.toString());
  } catch (err) {
    console.error('OAuth login error:', err);
    res.status(500).send(`Failed to start OAuth flow: ${err.message}`);
  }
});

// Spotify OAuth callback (for static redirect URI configuration)
app.get('/callback', async (req, res) => {
  // If using dynamic OAuth port, this endpoint should not receive callbacks
  if (USE_DYNAMIC_OAUTH_PORT) {
    return res.status(400).send('OAuth callback should be received on the dynamic loopback port. Please restart the OAuth flow by clicking "Connect Spotify" again.');
  }

  const { code, error, state } = req.query;

  // Verify state to prevent CSRF attacks
  if (state !== currentOAuthState) {
    return res.redirect('/?error=invalid_state');
  }

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
        redirect_uri: process.env.SPOTIFY_REDIRECT_URI
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
  const { uri, name, artist, albumArt } = req.body;
  const clientIP = getClientIP(req);

  if (!uri) {
    return res.status(400).json({ error: 'Track URI is required' });
  }

  // Check track limit per IP
  const currentCount = ipTrackCount[clientIP] || 0;
  if (currentCount >= MAX_TRACKS_PER_IP) {
    return res.status(429).json({ 
      error: `Track limit reached. You can only add ${MAX_TRACKS_PER_IP} tracks.`,
      remaining: 0
    });
  }

  try {
    const response = await spotifyFetch(`/me/player/queue?uri=${encodeURIComponent(uri)}`, {
      method: 'POST'
    });

    if (response.status === 204) {
      // Track submission count
      ipTrackCount[clientIP] = currentCount + 1;
      
      // Add to party queue for voting display
      // Extract track ID from Spotify URI (format: spotify:track:XXXXX)
      const uriParts = uri.split(':');
      const trackId = uriParts.length >= 3 ? uriParts[2] : uri;
      if (trackId && !partyQueue.find(t => t.id === trackId)) {
        partyQueue.push({
          id: trackId,
          uri,
          name: name || 'Unknown',
          artist: artist || 'Unknown',
          albumArt: albumArt || null,
          addedBy: clientIP,
          addedAt: Date.now(),
          votes: 0
        });
        trackVotes[trackId] = new Set();
      }
      
      return res.json({ 
        success: true, 
        message: 'Track added to queue',
        remaining: MAX_TRACKS_PER_IP - (currentCount + 1)
      });
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

// Get party queue with votes
app.get('/api/party-queue', (req, res) => {
  const clientIP = getClientIP(req);
  const sortedQueue = [...partyQueue].sort((a, b) => b.votes - a.votes);
  
  res.json({
    queue: sortedQueue.map(track => ({
      ...track,
      hasVoted: trackVotes[track.id]?.has(clientIP) || false
    })),
    remaining: MAX_TRACKS_PER_IP - (ipTrackCount[clientIP] || 0),
    maxTracks: MAX_TRACKS_PER_IP
  });
});

// Vote for a track
app.post('/api/vote/:trackId', (req, res) => {
  const { trackId } = req.params;
  const clientIP = getClientIP(req);
  
  const track = partyQueue.find(t => t.id === trackId);
  if (!track) {
    return res.status(404).json({ error: 'Track not found in queue' });
  }
  
  if (!trackVotes[trackId]) {
    trackVotes[trackId] = new Set();
  }
  
  if (trackVotes[trackId].has(clientIP)) {
    // Remove vote
    trackVotes[trackId].delete(clientIP);
    track.votes--;
    return res.json({ success: true, votes: track.votes, hasVoted: false });
  }
  
  // Add vote
  trackVotes[trackId].add(clientIP);
  track.votes++;
  res.json({ success: true, votes: track.votes, hasVoted: true });
});

// Get remaining tracks for current user
app.get('/api/track-limit', (req, res) => {
  const clientIP = getClientIP(req);
  const currentCount = ipTrackCount[clientIP] || 0;
  res.json({
    used: currentCount,
    remaining: MAX_TRACKS_PER_IP - currentCount,
    max: MAX_TRACKS_PER_IP
  });
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

// Admin authentication middleware
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'Admin panel not configured. Set ADMIN_PASSWORD environment variable.' });
  }
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  
  const token = authHeader.substring(7);
  if (!adminSessions.has(token)) {
    return res.status(403).json({ error: 'Invalid or expired admin session' });
  }
  
  next();
}

// Admin: Check if admin is configured
app.get('/api/admin/status', (req, res) => {
  res.json({ configured: !!ADMIN_PASSWORD });
});

// Admin: Verify credentials
app.post('/api/admin/login', authLimiter, (req, res) => {
  const { password } = req.body;
  
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'Admin panel not configured' });
  }
  
  if (password === ADMIN_PASSWORD) {
    const token = generateAdminToken();
    adminSessions.add(token);
    return res.json({ success: true, token });
  }
  
  res.status(403).json({ error: 'Invalid password' });
});

// Admin: Skip current track
app.post('/api/admin/skip', requireAdmin, ensureToken, async (req, res) => {
  try {
    const response = await spotifyFetch('/me/player/next', {
      method: 'POST'
    });

    if (response.status === 204 || response.ok) {
      return res.json({ success: true, message: 'Track skipped' });
    }

    if (response.status === 404) {
      return res.status(404).json({ error: 'No active device found' });
    }

    const errorData = await response.json();
    return res.status(response.status).json({ error: errorData.error?.message || 'Failed to skip track' });
  } catch (err) {
    console.error('Skip error:', err);
    res.status(500).json({ error: 'Failed to skip track' });
  }
});

// Admin: Remove track from party queue
app.delete('/api/admin/queue/:trackId', requireAdmin, (req, res) => {
  const { trackId } = req.params;
  
  const index = partyQueue.findIndex(t => t.id === trackId);
  if (index === -1) {
    return res.status(404).json({ error: 'Track not found in queue' });
  }
  
  partyQueue.splice(index, 1);
  delete trackVotes[trackId];
  
  res.json({ success: true, message: 'Track removed from party queue' });
});

// Admin: Clear all party queue
app.delete('/api/admin/queue', requireAdmin, (req, res) => {
  partyQueue = [];
  trackVotes = {};
  res.json({ success: true, message: 'Party queue cleared' });
});

// Admin: Reset track limits for an IP or all
app.post('/api/admin/reset-limits', requireAdmin, (req, res) => {
  const ip = req.body?.ip;
  
  if (ip) {
    delete ipTrackCount[ip];
    res.json({ success: true, message: `Track limit reset for ${ip}` });
  } else {
    ipTrackCount = {};
    res.json({ success: true, message: 'All track limits reset' });
  }
});

// Admin: Get all IPs with their track counts
app.get('/api/admin/track-limits', requireAdmin, (req, res) => {
  res.json({ limits: ipTrackCount });
});

// Admin: Pause playback
app.post('/api/admin/pause', requireAdmin, ensureToken, async (req, res) => {
  try {
    const response = await spotifyFetch('/me/player/pause', {
      method: 'PUT'
    });

    if (response.status === 204 || response.ok) {
      return res.json({ success: true, message: 'Playback paused' });
    }

    if (response.status === 404) {
      return res.status(404).json({ error: 'No active device found' });
    }

    const errorData = await response.json();
    return res.status(response.status).json({ error: errorData.error?.message || 'Failed to pause' });
  } catch (err) {
    console.error('Pause error:', err);
    res.status(500).json({ error: 'Failed to pause playback' });
  }
});

// Admin: Resume playback
app.post('/api/admin/play', requireAdmin, ensureToken, async (req, res) => {
  try {
    const response = await spotifyFetch('/me/player/play', {
      method: 'PUT'
    });

    if (response.status === 204 || response.ok) {
      return res.json({ success: true, message: 'Playback resumed' });
    }

    if (response.status === 404) {
      return res.status(404).json({ error: 'No active device found' });
    }

    const errorData = await response.json();
    return res.status(response.status).json({ error: errorData.error?.message || 'Failed to resume' });
  } catch (err) {
    console.error('Play error:', err);
    res.status(500).json({ error: 'Failed to resume playback' });
  }
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Get OAuth configuration status
app.get('/api/oauth-config', (req, res) => {
  res.json({
    useDynamicPort: USE_DYNAMIC_OAUTH_PORT,
    callbackPort: oauthCallbackPort,
    redirectUri: getSpotifyRedirectUri()
  });
});

// Start server
if (USE_HTTPS) {
  // HTTPS server
  const sslOptions = {
    key: fs.readFileSync(SSL_KEY_PATH),
    cert: fs.readFileSync(SSL_CERT_PATH)
  };
  
  https.createServer(sslOptions, app).listen(SSL_PORT, SSL_HOST, () => {
    console.log(`🎵 Party Jukebox running at https://${SSL_HOST}:${SSL_PORT}`);
    console.log(`   Secure LAN access: https://${SSL_HOST}:${SSL_PORT}`);
    
    if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
      console.log('\n⚠️  Warning: Spotify credentials not configured!');
      console.log('   Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables.');
    }
    
    if (USE_DYNAMIC_OAUTH_PORT) {
      console.log('\n🔐 OAuth Mode: Dynamic loopback port (RFC 8252 compliant)');
      console.log('   Redirect URI will be assigned when OAuth flow starts');
      console.log('   Ensure your Spotify app allows any port on http://127.0.0.1/callback');
    } else {
      console.log(`\n🔐 OAuth Mode: Static redirect URI`);
      console.log(`   Redirect URI: ${process.env.SPOTIFY_REDIRECT_URI}`);
    }
  });
} else {
  // HTTP server (default)
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🎵 Party Jukebox running at http://localhost:${PORT}`);
    console.log(`   LAN access: http://<your-local-ip>:${PORT}`);
    
    if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
      console.log('\n⚠️  Warning: Spotify credentials not configured!');
      console.log('   Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables.');
    }
    
    if (USE_DYNAMIC_OAUTH_PORT) {
      console.log('\n🔐 OAuth Mode: Dynamic loopback port (RFC 8252 compliant)');
      console.log('   Redirect URI will be assigned when OAuth flow starts');
      console.log('   Ensure your Spotify app allows any port on http://127.0.0.1/callback');
    } else {
      console.log(`\n🔐 OAuth Mode: Static redirect URI`);
      console.log(`   Redirect URI: ${process.env.SPOTIFY_REDIRECT_URI}`);
    }
  });
}

// Export for testing
module.exports = {
  app,
  startOAuthCallbackServer,
  stopOAuthCallbackServer,
  getSpotifyRedirectUri,
  USE_DYNAMIC_OAUTH_PORT,
  USE_HTTPS
};
