require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const https = require('https');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const morgan = require('morgan');
const logger = require('./logger');

const app = express();
const PORT = process.env.PORT || 3000;

// Time constants (in milliseconds)
const MS_PER_MINUTE = 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 15 * MS_PER_MINUTE;
const TOKEN_REFRESH_BUFFER_MS = 5 * MS_PER_MINUTE;

// SSL/HTTPS configuration
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || '';
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || '';
const SSL_PORT = parseInt(process.env.SSL_PORT, 10) || 443;
const SSL_HOST = process.env.SSL_HOST || '0.0.0.0';
const USE_HTTPS = !!(SSL_CERT_PATH && SSL_KEY_PATH);

// Validate SSL configuration
if (USE_HTTPS) {
  if (!fs.existsSync(SSL_CERT_PATH)) {
    logger.error(`SSL certificate file not found: ${SSL_CERT_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(SSL_KEY_PATH)) {
    logger.error(`SSL key file not found: ${SSL_KEY_PATH}`);
    process.exit(1);
  }
}

// Party configuration
const MAX_TRACKS_PER_IP = parseInt(process.env.MAX_TRACKS_PER_IP, 10) || 5;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// Rate limiting configuration
const generalLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});

const authLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: 10,
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
// User nicknames: { ip: nickname }
let userNicknames = {};

// Playback state cache to reduce Spotify API calls
let playbackCache = {
  data: null,
  timestamp: 0,
  ttl: 15000 // 15 seconds cache TTL
};

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

// Generate Spotify Basic Auth header
function getSpotifyBasicAuth() {
  return 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64');
}

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

/**
 * Exchange OAuth authorization code for tokens
 * @param {string} code - The authorization code from Spotify
 * @param {string} redirectUri - The redirect URI used in the authorization request
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function exchangeCodeForTokens(code, redirectUri) {
  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': getSpotifyBasicAuth()
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: redirectUri
      })
    });

    if (!response.ok) {
      const errorMessage = await parseSpotifyErrorResponse(response, 'Token exchange failed');
      logger.error('OAuth token exchange failed', { error: errorMessage });
      return { success: false, error: 'token_exchange_failed' };
    }

    const data = await response.json();
    tokenData.accessToken = data.access_token;
    tokenData.refreshToken = data.refresh_token;
    tokenData.expiresAt = Date.now() + (data.expires_in * 1000);
    
    logger.info('OAuth authentication successful');
    return { success: true };
  } catch (err) {
    logger.error('OAuth callback error', { error: err.message });
    return { success: false, error: 'callback_failed' };
  }
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

      const redirectUri = getSpotifyRedirectUri();
      const result = await exchangeCodeForTokens(code, redirectUri);
      
      if (result.success) {
        res.redirect(`${mainAppUrl}/?authenticated=true`);
      } else {
        res.redirect(`${mainAppUrl}/?error=${result.error}`);
      }
    });

    // Bind to 127.0.0.1 (loopback) on port 0 to get a random available port
    oauthCallbackServer = callbackApp.listen(0, '127.0.0.1', () => {
      oauthCallbackPort = oauthCallbackServer.address().port;
      logger.info('OAuth callback server started', { port: oauthCallbackPort, url: `http://127.0.0.1:${oauthCallbackPort}/callback` });
      resolve(oauthCallbackPort);
    });

    oauthCallbackServer.on('error', (err) => {
      logger.error('Failed to start OAuth callback server', { error: err.message });
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
    logger.info('OAuth callback server stopped');
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

// HTTP request logging with morgan
const MORGAN_FORMAT = ':remote-addr - :method :url :status :res[content-length] - :response-time ms';
app.use(morgan(MORGAN_FORMAT, { stream: logger.stream }));

// Helper function to make Spotify API requests with timeout and retry logic
async function spotifyFetch(endpoint, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `https://api.spotify.com/v1${endpoint}`;
  const maxRetries = 3;
  const timeoutMs = 10000; // 10 seconds
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Authorization': `Bearer ${tokenData.accessToken}`,
          'Content-Type': 'application/json',
          ...options.headers
        },
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      // Check if we should retry based on status code
      if (response.ok || attempt === maxRetries) {
        // Success or final attempt - return response
        if (attempt > 0) {
          logger.info(`Spotify API call succeeded after ${attempt} retries`, { 
            endpoint: url, 
            statusCode: response.status 
          });
        }
        return response;
      }
      
      // Determine if we should retry
      const shouldRetry = (
        response.status === 429 || // Rate limit
        response.status >= 500 || // Server errors (includes 500, 502, 503, 504, etc.)
        response.status === 408    // Request timeout
      );
      
      if (!shouldRetry) {
        // Don't retry on 4xx client errors (except 429)
        logger.warn(`Spotify API call failed with non-retryable status`, { 
          endpoint: url, 
          statusCode: response.status,
          attempt: attempt + 1
        });
        return response;
      }
      
      // Log retry attempt
      logger.warn(`Spotify API call failed, will retry`, { 
        endpoint: url, 
        statusCode: response.status,
        attempt: attempt + 1,
        maxRetries: maxRetries
      });
      
      // Wait before retrying with exponential backoff
      const delayMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
      await new Promise(resolve => setTimeout(resolve, delayMs));
      
    } catch (err) {
      clearTimeout(timeoutId);
      
      // Check if this is a timeout/network error that should be retried
      const isRetryable = (
        err.name === 'AbortError' || // Timeout
        err.message.includes('fetch failed') || // Network error
        err.message.includes('ECONNRESET') ||
        err.message.includes('ETIMEDOUT')
      );
      
      if (!isRetryable || attempt === maxRetries) {
        // Don't retry or final attempt - throw error
        logger.error(`Spotify API call failed after ${attempt + 1} attempts`, { 
          endpoint: url,
          error: err.message,
          errorName: err.name,
          attempt: attempt + 1
        });
        throw err;
      }
      
      // Log retry attempt
      logger.warn(`Spotify API call failed with network error, will retry`, { 
        endpoint: url,
        error: err.message,
        errorName: err.name,
        attempt: attempt + 1,
        maxRetries: maxRetries
      });
      
      // Wait before retrying with exponential backoff
      const delayMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Parse error response from Spotify API.
 * Spotify may return non-JSON error responses (e.g., plain strings).
 * First read as text, then try to parse as JSON. Fall back to the text or generic message.
 * @param {Response} response - The fetch Response object
 * @param {string} fallbackMessage - The fallback error message if parsing fails
 * @returns {Promise<string>} The parsed error message
 */
async function parseSpotifyErrorResponse(response, fallbackMessage) {
  let errorMessage = fallbackMessage;
  try {
    const responseText = await response.text();
    if (responseText && responseText.trim()) {
      try {
        // Try to parse as JSON
        const errorData = JSON.parse(responseText);
        if (errorData.error?.message) {
          errorMessage = errorData.error.message;
        }
      } catch {
        // Not valid JSON, use the raw text as the error message
        errorMessage = responseText.trim();
      }
    }
  } catch {
    // Failed to read response body, use the fallback error message
  }
  return errorMessage;
}

// Check if host is authenticated
function isAuthenticated() {
  return tokenData.accessToken && tokenData.expiresAt && Date.now() < tokenData.expiresAt;
}

// Refresh access token
async function refreshAccessToken() {
  if (!tokenData.refreshToken) {
    logger.warn('Token refresh attempted without refresh token');
    return false;
  }

  try {
    logger.info('Token refresh: Starting', {
      expiresAt: new Date(tokenData.expiresAt).toISOString(),
      timeUntilExpiry: Math.floor((tokenData.expiresAt - Date.now()) / 1000) + 's'
    });

    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': getSpotifyBasicAuth()
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokenData.refreshToken
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Token refresh failed', {
        statusCode: response.status,
        error: errorText
      });
      return false;
    }

    const data = await response.json();
    tokenData.accessToken = data.access_token;
    tokenData.expiresAt = Date.now() + (data.expires_in * 1000);
    if (data.refresh_token) {
      tokenData.refreshToken = data.refresh_token;
    }
    
    logger.info('Token refresh: Success', {
      expiresIn: data.expires_in + 's',
      newExpiresAt: new Date(tokenData.expiresAt).toISOString()
    });
    return true;
  } catch (error) {
    logger.error('Token refresh error', { error: error.message });
    return false;
  }
}

// Middleware to ensure token is valid
async function ensureToken(req, res, next) {
  if (!tokenData.accessToken) {
    return res.status(401).json({ error: 'Host not authenticated. Please authenticate first.' });
  }

  // Refresh token if expired or about to expire (within buffer time)
  if (Date.now() >= tokenData.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
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
    status: 'ok',
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
    logger.error('QR code generation error', { error: err.message });
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

    logger.info('OAuth flow started', { redirectUri, useDynamicPort: USE_DYNAMIC_OAUTH_PORT });
    res.redirect(authUrl.toString());
  } catch (err) {
    logger.error('OAuth login error', { error: err.message });
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

  const result = await exchangeCodeForTokens(code, process.env.SPOTIFY_REDIRECT_URI);
  
  if (result.success) {
    res.redirect('/?authenticated=true');
  } else {
    res.redirect('/?error=' + result.error);
  }
});

// Search for tracks
app.get('/api/search', ensureToken, async (req, res) => {
  const { q } = req.query;
  const clientIP = getClientIP(req);

  if (!q || q.trim() === '') {
    return res.status(400).json({ error: 'Search query is required' });
  }

  try {
    const response = await spotifyFetch(`/search?type=track&limit=20&q=${encodeURIComponent(q)}`);

    logger.info('Spotify API: Search tracks', {
      endpoint: '/search',
      method: 'GET',
      statusCode: response.status,
      query: q,
      clientIP
    });

    if (!response.ok) {
      const errorMessage = await parseSpotifyErrorResponse(response, 'Search failed');
      logger.error('Spotify API: Search failed', {
        endpoint: '/search',
        statusCode: response.status,
        error: errorMessage,
        query: q,
        clientIP
      });
      return res.status(response.status).json({ error: errorMessage });
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
    logger.error('Spotify search error', { error: err.message, query: q, clientIP });
    res.status(500).json({ error: 'Failed to search tracks' });
  }
});

// Add track to queue
app.post('/api/queue', ensureToken, async (req, res) => {
  const { uri, name, artist, albumArt, nickname } = req.body;
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

    // Log Spotify API response
    logger.info('Spotify API: Add to queue', {
      endpoint: '/me/player/queue',
      method: 'POST',
      statusCode: response.status,
      uri,
      clientIP
    });

    // Accept both 200 and 204 as success responses
    if (response.status === 200 || response.status === 204) {
      // Track submission count
      ipTrackCount[clientIP] = currentCount + 1;
      
      // Store nickname if provided
      if (nickname) {
        userNicknames[clientIP] = nickname;
      }
      
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
          addedByName: userNicknames[clientIP] || nickname || 'Guest',
          addedAt: Date.now(),
          votes: 0
        });
        trackVotes[trackId] = new Set();
        
        logger.info('Party queue: Track added', {
          trackId,
          trackName: name,
          artist,
          clientIP,
          addedByName: userNicknames[clientIP] || nickname || 'Guest',
          queueSize: partyQueue.length
        });
      }
      
      logger.info('Track limit enforced', {
        clientIP,
        used: currentCount + 1,
        remaining: MAX_TRACKS_PER_IP - (currentCount + 1),
        max: MAX_TRACKS_PER_IP
      });
      
      return res.json({ 
        success: true, 
        message: 'Track added to queue',
        remaining: MAX_TRACKS_PER_IP - (currentCount + 1)
      });
    }

    if (response.status === 404) {
      logger.warn('Spotify API: No active device', { clientIP, uri });
      return res.status(404).json({ error: 'No active device found. Please start playing on Spotify first.' });
    }

    const errorMessage = await parseSpotifyErrorResponse(response, 'Failed to add to queue');
    logger.error('Spotify API: Queue add failed', {
      endpoint: '/me/player/queue',
      statusCode: response.status,
      error: errorMessage,
      uri,
      clientIP
    });
    return res.status(response.status).json({ error: errorMessage });
  } catch (err) {
    logger.error('Spotify queue error', { error: err.message, uri, clientIP });
    res.status(500).json({ error: 'Failed to add track to queue' });
  }
});

// Get party queue with votes
app.get('/api/party-queue', (req, res) => {
  const clientIP = getClientIP(req);
  const sortedQueue = [...partyQueue].sort((a, b) => b.votes - a.votes);
  
  // Prevent browser caching of dynamic queue data
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  
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
    logger.info('Party queue: Vote removed', {
      trackId,
      trackName: track.name,
      clientIP,
      newVoteCount: track.votes
    });
    return res.json({ success: true, votes: track.votes, hasVoted: false });
  }
  
  // Add vote
  trackVotes[trackId].add(clientIP);
  track.votes++;
  logger.info('Party queue: Vote added', {
    trackId,
    trackName: track.name,
    clientIP,
    newVoteCount: track.votes
  });
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
    // Check cache first
    const now = Date.now();
    if (playbackCache.data && (now - playbackCache.timestamp) < playbackCache.ttl) {
      logger.debug('Playback state: Serving from cache', {
        cacheAge: Math.floor((now - playbackCache.timestamp) / 1000) + 's'
      });
      return res.json(playbackCache.data);
    }

    const response = await spotifyFetch('/me/player');

    logger.info('Spotify API: Get playback state', {
      endpoint: '/me/player',
      method: 'GET',
      statusCode: response.status
    });

    if (response.status === 204) {
      const result = { playing: false, device: null };
      playbackCache.data = result;
      playbackCache.timestamp = now;
      return res.json(result);
    }

    if (!response.ok) {
      logger.error('Spotify API: Get playback state failed', {
        endpoint: '/me/player',
        statusCode: response.status
      });
      return res.status(response.status).json({ error: 'Failed to get playback state' });
    }

    const data = await response.json();
    const result = {
      playing: data.is_playing,
      device: data.device?.name || null,
      track: data.item ? {
        name: data.item.name,
        artist: data.item.artists.map(a => a.name).join(', '),
        albumArt: data.item.album.images[0]?.url || null
      } : null
    };
    
    // Update cache
    playbackCache.data = result;
    playbackCache.timestamp = now;
    
    res.json(result);
  } catch (err) {
    logger.error('Spotify playback state error', { error: err.message });
    res.status(500).json({ error: 'Failed to get playback state' });
  }
});

// Logout (clear tokens)
app.post('/api/logout', (req, res) => {
  tokenData = { accessToken: null, refreshToken: null, expiresAt: null };
  logger.info('User logged out, tokens cleared');
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
    logger.info('Admin login successful', { ip: getClientIP(req) });
    return res.json({ success: true, token });
  }
  
  logger.warn('Admin login failed: invalid password', { ip: getClientIP(req) });
  res.status(403).json({ error: 'Invalid password' });
});

// Admin: Skip current track
app.post('/api/admin/skip', requireAdmin, ensureToken, async (req, res) => {
  const clientIP = getClientIP(req);
  try {
    const response = await spotifyFetch('/me/player/next', {
      method: 'POST'
    });

    if (response.status === 204 || response.ok) {
      logger.info('Admin action: Skip track', { 
        action: 'skip',
        clientIP,
        statusCode: response.status
      });
      return res.json({ success: true, message: 'Track skipped' });
    }

    if (response.status === 404) {
      logger.warn('Admin action failed: No active device', { action: 'skip', clientIP });
      return res.status(404).json({ error: 'No active device found' });
    }

    const errorMessage = await parseSpotifyErrorResponse(response, 'Failed to skip track');
    logger.error('Admin action failed', {
      action: 'skip',
      clientIP,
      statusCode: response.status,
      error: errorMessage
    });
    return res.status(response.status).json({ error: errorMessage });
  } catch (err) {
    logger.error('Admin skip track error', { error: err.message, clientIP });
    res.status(500).json({ error: 'Failed to skip track' });
  }
});

// Admin: Remove track from party queue
app.delete('/api/admin/queue/:trackId', requireAdmin, (req, res) => {
  const { trackId } = req.params;
  const clientIP = getClientIP(req);
  
  const index = partyQueue.findIndex(t => t.id === trackId);
  if (index === -1) {
    return res.status(404).json({ error: 'Track not found in queue' });
  }
  
  const removedTrack = partyQueue[index];
  partyQueue.splice(index, 1);
  delete trackVotes[trackId];
  
  logger.info('Admin action: Remove track from queue', {
    action: 'remove_track',
    trackId,
    trackName: removedTrack.name,
    clientIP,
    queueSize: partyQueue.length
  });
  res.json({ success: true, message: 'Track removed from party queue' });
});

// Admin: Clear all party queue
app.delete('/api/admin/queue', requireAdmin, (req, res) => {
  const clientIP = getClientIP(req);
  const previousQueueSize = partyQueue.length;
  
  partyQueue = [];
  trackVotes = {};
  
  logger.info('Admin action: Clear party queue', {
    action: 'clear_queue',
    clientIP,
    previousQueueSize,
    newQueueSize: 0
  });
  res.json({ success: true, message: 'Party queue cleared' });
});

// Admin: Reset track limits for an IP or all
app.post('/api/admin/reset-limits', requireAdmin, (req, res) => {
  const ip = req.body?.ip;
  const clientIP = getClientIP(req);
  
  if (ip) {
    const previousCount = ipTrackCount[ip] || 0;
    delete ipTrackCount[ip];
    logger.info('Admin action: Reset track limit for IP', {
      action: 'reset_limits',
      targetIP: ip,
      previousCount,
      clientIP
    });
    res.json({ success: true, message: `Track limit reset for ${ip}` });
  } else {
    const totalIPs = Object.keys(ipTrackCount).length;
    ipTrackCount = {};
    logger.info('Admin action: Reset all track limits', {
      action: 'reset_all_limits',
      previousIPCount: totalIPs,
      clientIP
    });
    res.json({ success: true, message: 'All track limits reset' });
  }
});

// Admin: Get all IPs with their track counts
app.get('/api/admin/track-limits', requireAdmin, (req, res) => {
  res.json({ limits: ipTrackCount });
});

// Admin: Pause playback
app.post('/api/admin/pause', requireAdmin, ensureToken, async (req, res) => {
  const clientIP = getClientIP(req);
  try {
    const response = await spotifyFetch('/me/player/pause', {
      method: 'PUT'
    });

    if (response.status === 204 || response.ok) {
      logger.info('Admin action: Pause playback', {
        action: 'pause',
        clientIP,
        statusCode: response.status
      });
      return res.json({ success: true, message: 'Playback paused' });
    }

    if (response.status === 404) {
      logger.warn('Admin action failed: No active device', { action: 'pause', clientIP });
      return res.status(404).json({ error: 'No active device found' });
    }

    const errorMessage = await parseSpotifyErrorResponse(response, 'Failed to pause');
    logger.error('Admin action failed', {
      action: 'pause',
      clientIP,
      statusCode: response.status,
      error: errorMessage
    });
    return res.status(response.status).json({ error: errorMessage });
  } catch (err) {
    logger.error('Admin pause playback error', { error: err.message, clientIP });
    res.status(500).json({ error: 'Failed to pause playback' });
  }
});

// Admin: Resume playback
app.post('/api/admin/play', requireAdmin, ensureToken, async (req, res) => {
  const clientIP = getClientIP(req);
  try {
    const response = await spotifyFetch('/me/player/play', {
      method: 'PUT'
    });

    if (response.status === 204 || response.ok) {
      logger.info('Admin action: Resume playback', {
        action: 'play',
        clientIP,
        statusCode: response.status
      });
      return res.json({ success: true, message: 'Playback resumed' });
    }

    if (response.status === 404) {
      logger.warn('Admin action failed: No active device', { action: 'play', clientIP });
      return res.status(404).json({ error: 'No active device found' });
    }

    const errorMessage = await parseSpotifyErrorResponse(response, 'Failed to resume');
    logger.error('Admin action failed', {
      action: 'play',
      clientIP,
      statusCode: response.status,
      error: errorMessage
    });
    return res.status(response.status).json({ error: errorMessage });
  } catch (err) {
    logger.error('Admin resume playback error', { error: err.message, clientIP });
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
    const displayHost = SSL_HOST === '0.0.0.0' ? '<your-local-ip>' : SSL_HOST;
    const portSuffix = SSL_PORT === 443 ? '' : `:${SSL_PORT}`;
    logger.info('Party Jukebox server started (HTTPS)', {
      url: `https://${displayHost}${portSuffix}`,
      host: SSL_HOST,
      port: SSL_PORT
    });
    
    if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
      logger.warn('Spotify credentials not configured', {
        message: 'Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables'
      });
    }
    
    if (USE_DYNAMIC_OAUTH_PORT) {
      logger.info('OAuth Mode: Dynamic loopback port (RFC 8252 compliant)', {
        note: 'Redirect URI will be assigned when OAuth flow starts'
      });
    } else {
      logger.info('OAuth Mode: Static redirect URI', {
        redirectUri: process.env.SPOTIFY_REDIRECT_URI
      });
    }
  });
} else {
  // HTTP server (default)
  app.listen(PORT, '0.0.0.0', () => {
    logger.info('Party Jukebox server started (HTTP)', {
      url: `http://localhost:${PORT}`,
      port: PORT
    });
    
    if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
      logger.warn('Spotify credentials not configured', {
        message: 'Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET environment variables'
      });
    }
    
    if (USE_DYNAMIC_OAUTH_PORT) {
      logger.info('OAuth Mode: Dynamic loopback port (RFC 8252 compliant)', {
        note: 'Redirect URI will be assigned when OAuth flow starts'
      });
    } else {
      logger.info('OAuth Mode: Static redirect URI', {
        redirectUri: process.env.SPOTIFY_REDIRECT_URI
      });
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
