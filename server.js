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
const db = require('./database');

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

// Application branding
const APP_TITLE = process.env.APP_TITLE || 'Party JukeBox';
const APP_BYLINE = process.env.APP_BYLINE || 'Your collaborative music queue';

// Track limit enforcement (can be toggled by admin)
let enforceTrackLimits = process.env.ENFORCE_TRACK_LIMITS !== 'false';

// Rate limiting configuration
const generalLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
  handler: (req, res) => {
    const clientIP = getClientIP(req);
    logger.warn('Rate limit hit', {
      endpoint: req.path,
      method: req.method,
      clientIP,
      limit: 100,
      windowMs: RATE_LIMIT_WINDOW_MS,
      windowMinutes: RATE_LIMIT_WINDOW_MS / MS_PER_MINUTE
    });
    res.status(429).json({ error: 'Too many requests, please try again later.' });
  }
});

const authLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: 10,
  message: { error: 'Too many authentication attempts, please try again later.' },
  handler: (req, res) => {
    const clientIP = getClientIP(req);
    logger.warn('Auth rate limit hit', {
      endpoint: req.path,
      method: req.method,
      clientIP,
      limit: 10,
      windowMs: RATE_LIMIT_WINDOW_MS,
      windowMinutes: RATE_LIMIT_WINDOW_MS / MS_PER_MINUTE
    });
    res.status(429).json({ error: 'Too many authentication attempts, please try again later.' });
  }
});

// In-memory storage for tokens (in production, use a proper session store)
let tokenData = {
  accessToken: null,
  refreshToken: null,
  expiresAt: null
};

// Playback state cache to reduce Spotify API calls
let playbackCache = {
  data: null,
  timestamp: 0,
  ttl: 15000 // 15 seconds cache TTL
};

// Spotify queue cache to reduce API calls
let spotifyQueueCache = {
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
  logger.debug('Token exchange starting', {
    hasCode: !!code,
    redirectUri,
    endpoint: 'https://accounts.spotify.com/api/token'
  });
  
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
      logger.error('OAuth token exchange failed', { 
        error: errorMessage,
        statusCode: response.status
      });
      
      logger.debug('Token exchange error details', {
        statusCode: response.status,
        errorMessage,
        redirectUri
      });
      
      return { success: false, error: 'token_exchange_failed' };
    }

    const data = await response.json();
    
    const oldTokenData = {
      hasAccessToken: !!tokenData.accessToken,
      hasRefreshToken: !!tokenData.refreshToken
    };
    
    tokenData.accessToken = data.access_token;
    tokenData.refreshToken = data.refresh_token;
    tokenData.expiresAt = Date.now() + (data.expires_in * 1000);
    
    logger.verbose('Token storage updated', {
      accessToken: 'set',
      refreshToken: 'set',
      expiresAt: new Date(tokenData.expiresAt).toISOString(),
      expiresInSeconds: data.expires_in
    });
    
    logger.info('OAuth authentication successful');
    
    logger.debug('Token exchange successful', {
      hasAccessToken: !!data.access_token,
      hasRefreshToken: !!data.refresh_token,
      expiresIn: data.expires_in
    });
    
    return { success: true };
  } catch (err) {
    logger.error('OAuth callback error', { 
      error: err.message,
      stack: err.stack
    });
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

      logger.verbose('OAuth dynamic callback received', {
        hasCode: !!code,
        hasError: !!error,
        hasState: !!state,
        port: oauthCallbackPort
      });

      // Verify state to prevent CSRF attacks
      if (state !== currentOAuthState) {
        logger.warn('OAuth state mismatch on dynamic callback', {
          expected: currentOAuthState ? currentOAuthState.substring(0, 8) + '...' : null,
          received: state ? state.substring(0, 8) + '...' : null,
          reason: 'csrf_protection'
        });
        res.status(400).send('Invalid OAuth state. Please try again.');
        return;
      }

      if (error) {
        logger.warn('OAuth dynamic callback error', {
          error,
          source: 'spotify'
        });
        res.redirect(`${mainAppUrl}/?error=${encodeURIComponent(error)}`);
        return;
      }

      if (!code) {
        logger.warn('OAuth dynamic callback missing code');
        res.redirect(`${mainAppUrl}/?error=no_code`);
        return;
      }

      const redirectUri = getSpotifyRedirectUri();
      
      logger.debug('OAuth dynamic callback: Exchanging code', {
        hasCode: true,
        redirectUri
      });
      
      const result = await exchangeCodeForTokens(code, redirectUri);
      
      if (result.success) {
        logger.info('OAuth dynamic callback: Success', {
          redirecting: 'main_app'
        });
        res.redirect(`${mainAppUrl}/?authenticated=true`);
      } else {
        logger.warn('OAuth dynamic callback: Token exchange failed', {
          error: result.error
        });
        res.redirect(`${mainAppUrl}/?error=${result.error}`);
      }
    });

    // Bind to 127.0.0.1 (loopback) on port 0 to get a random available port
    oauthCallbackServer = callbackApp.listen(0, '127.0.0.1', () => {
      oauthCallbackPort = oauthCallbackServer.address().port;
      const callbackUrl = `http://127.0.0.1:${oauthCallbackPort}/callback`;
      
      logger.info('OAuth callback server started', { 
        port: oauthCallbackPort, 
        url: callbackUrl
      });
      
      logger.debug('OAuth dynamic port selected', {
        port: oauthCallbackPort,
        address: '127.0.0.1',
        protocol: 'http'
      });
      
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
  const token = crypto.randomBytes(32).toString('hex');
  
  logger.verbose('Admin session token generated', {
    tokenLength: token.length,
    encoding: 'hex'
  });
  
  return token;
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
  const startTime = Date.now();
  
  logger.debug('Spotify API request', {
    endpoint: url,
    method: options.method || 'GET',
    hasBody: !!options.body,
    body: options.body,
    headers: options.headers ? Object.keys(options.headers) : []
  });
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      const attemptStartTime = Date.now();
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
      const responseTime = Date.now() - attemptStartTime;
      const totalTime = Date.now() - startTime;
      
      logger.debug('Spotify API response', {
        endpoint: url,
        method: options.method || 'GET',
        statusCode: response.status,
        responseTimeMs: responseTime,
        totalTimeMs: totalTime,
        attempt: attempt + 1,
        isSuccess: response.ok
      });
      
      // Check if we should retry based on status code
      if (response.ok || attempt === maxRetries) {
        // Success or final attempt - return response
        if (attempt > 0) {
          logger.info(`Spotify API call succeeded after ${attempt} retries`, { 
            endpoint: url, 
            statusCode: response.status,
            totalAttempts: attempt + 1,
            totalTimeMs: totalTime
          });
        }
        
        logger.info('Spotify API timing', {
          endpoint: url,
          method: options.method || 'GET',
          statusCode: response.status,
          responseTimeMs: responseTime,
          retriesUsed: attempt
        });
        
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
        // Log error response body at debug level
        const responseText = await response.text();
        logger.debug('Spotify API error response body', {
          endpoint: url,
          statusCode: response.status,
          responseBody: responseText
        });
        
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
        maxRetries: maxRetries,
        retryNumber: attempt + 1
      });
      
      // Wait before retrying with exponential backoff
      const delayMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
      await new Promise(resolve => setTimeout(resolve, delayMs));
      
    } catch (err) {
      clearTimeout(timeoutId);
      
      logger.debug('Spotify API request error', {
        endpoint: url,
        error: err.message,
        errorName: err.name,
        stack: err.stack,
        attempt: attempt + 1
      });
      
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
          attempt: attempt + 1,
          totalTimeMs: Date.now() - startTime
        });
        throw err;
      }
      
      // Log retry attempt
      logger.warn(`Spotify API call failed with network error, will retry`, { 
        endpoint: url,
        error: err.message,
        errorName: err.name,
        attempt: attempt + 1,
        maxRetries: maxRetries,
        retryNumber: attempt + 1
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
    const timeUntilExpiry = tokenData.expiresAt ? Math.floor((tokenData.expiresAt - Date.now()) / 1000) : 0;
    
    logger.debug('Token refresh attempt', {
      currentToken: tokenData.accessToken ? 'present' : 'missing',
      expiresAt: tokenData.expiresAt ? new Date(tokenData.expiresAt).toISOString() : null,
      timeUntilExpirySeconds: timeUntilExpiry,
      refreshToken: tokenData.refreshToken ? 'present' : 'missing'
    });
    
    logger.info('Token refresh: Starting', {
      expiresAt: new Date(tokenData.expiresAt).toISOString(),
      timeUntilExpiry: timeUntilExpiry + 's'
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
        error: errorText,
        hadRefreshToken: !!tokenData.refreshToken,
        endpoint: 'https://accounts.spotify.com/api/token'
      });
      logger.debug('Token refresh failure details', {
        responseBody: errorText,
        statusCode: response.status,
        headers: Object.fromEntries(response.headers.entries())
      });
      return false;
    }

    const data = await response.json();
    
    const oldAccessToken = tokenData.accessToken ? 'present' : 'missing';
    const oldRefreshToken = tokenData.refreshToken ? 'present' : 'missing';
    const oldExpiresAt = tokenData.expiresAt;
    
    tokenData.accessToken = data.access_token;
    tokenData.expiresAt = Date.now() + (data.expires_in * 1000);
    if (data.refresh_token) {
      tokenData.refreshToken = data.refresh_token;
    }
    
    logger.verbose('Token storage updated', {
      accessToken: 'updated',
      refreshToken: data.refresh_token ? 'updated' : 'unchanged',
      oldExpiresAt: oldExpiresAt ? new Date(oldExpiresAt).toISOString() : null,
      newExpiresAt: new Date(tokenData.expiresAt).toISOString()
    });
    
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
    logger.verbose('Token validation failed: No access token', {
      endpoint: req.path,
      method: req.method
    });
    return res.status(401).json({ error: 'Host not authenticated. Please authenticate first.' });
  }

  const timeUntilExpiry = tokenData.expiresAt - Date.now();
  const needsRefresh = Date.now() >= tokenData.expiresAt - TOKEN_REFRESH_BUFFER_MS;
  
  logger.verbose('Token validation', {
    hasAccessToken: true,
    expiresAt: new Date(tokenData.expiresAt).toISOString(),
    timeUntilExpirySeconds: Math.floor(timeUntilExpiry / 1000),
    needsRefresh,
    endpoint: req.path,
    method: req.method
  });

  // Refresh token if expired or about to expire (within buffer time)
  if (needsRefresh) {
    logger.debug('Token refresh needed', {
      reason: timeUntilExpiry <= 0 ? 'expired' : 'within_buffer',
      timeUntilExpirySeconds: Math.floor(timeUntilExpiry / 1000),
      bufferSeconds: TOKEN_REFRESH_BUFFER_MS / 1000
    });
    
    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      const oldTokenData = { ...tokenData };
      tokenData = { accessToken: null, refreshToken: null, expiresAt: null };
      
      logger.warn('Token cleared after failed refresh', {
        hadAccessToken: !!oldTokenData.accessToken,
        hadRefreshToken: !!oldTokenData.refreshToken,
        endpoint: req.path
      });
      
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

// Get app configuration
app.get('/api/config', (req, res) => {
  res.json({
    appTitle: APP_TITLE,
    appByline: APP_BYLINE,
    maxTracksPerIP: MAX_TRACKS_PER_IP,
    enforceTrackLimits: enforceTrackLimits
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
        logger.debug('Starting OAuth callback server', {
          mode: 'dynamic_port',
          loopbackAddress: '127.0.0.1'
        });
        
        await startOAuthCallbackServer();
        
        logger.info('OAuth callback server started', {
          port: oauthCallbackPort,
          mode: 'dynamic'
        });
      }
      redirectUri = getSpotifyRedirectUri();
      
      if (!redirectUri) {
        logger.error('OAuth redirect URI unavailable', {
          oauthCallbackPort,
          oauthCallbackServer: !!oauthCallbackServer
        });
        return res.status(500).send('Failed to start OAuth callback server. Unable to allocate a free port on the loopback interface.');
      }
    } else {
      redirectUri = process.env.SPOTIFY_REDIRECT_URI;
      
      logger.debug('Using static OAuth redirect URI', {
        mode: 'static',
        redirectUri
      });
    }

    const state = crypto.randomBytes(16).toString('hex');
    currentOAuthState = state;
    
    logger.debug('OAuth state generated', {
      stateLength: state.length,
      statePreview: state.substring(0, 8) + '...'
    });
    
    const scope = 'user-read-playback-state user-modify-playback-state';

    const authUrl = new URL('https://accounts.spotify.com/authorize');
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('client_id', SPOTIFY_CLIENT_ID);
    authUrl.searchParams.append('scope', scope);
    authUrl.searchParams.append('redirect_uri', redirectUri);
    authUrl.searchParams.append('state', state);

    logger.debug('OAuth authorization URL constructed', {
      redirectUri,
      scope,
      clientId: SPOTIFY_CLIENT_ID.substring(0, 8) + '...',
      hasState: !!state
    });

    logger.info('OAuth flow started', { 
      redirectUri, 
      useDynamicPort: USE_DYNAMIC_OAUTH_PORT,
      clientIP: getClientIP(req)
    });
    
    res.redirect(authUrl.toString());
  } catch (err) {
    logger.error('OAuth login error', { 
      error: err.message,
      stack: err.stack,
      useDynamicPort: USE_DYNAMIC_OAUTH_PORT
    });
    res.status(500).send(`Failed to start OAuth flow: ${err.message}`);
  }
});

// Spotify OAuth callback (for static redirect URI configuration)
app.get('/callback', async (req, res) => {
  // If using dynamic OAuth port, this endpoint should not receive callbacks
  if (USE_DYNAMIC_OAUTH_PORT) {
    logger.warn('OAuth callback received on wrong endpoint', {
      mode: 'dynamic_port',
      shouldUseDynamicPort: true
    });
    return res.status(400).send('OAuth callback should be received on the dynamic loopback port. Please restart the OAuth flow by clicking "Connect Spotify" again.');
  }

  const { code, error, state } = req.query;

  logger.verbose('OAuth callback processing', {
    hasCode: !!code,
    hasError: !!error,
    hasState: !!state,
    expectedState: currentOAuthState ? currentOAuthState.substring(0, 8) + '...' : null,
    receivedState: state ? state.substring(0, 8) + '...' : null
  });

  // Verify state to prevent CSRF attacks
  if (state !== currentOAuthState) {
    logger.warn('OAuth state mismatch', {
      expected: currentOAuthState,
      received: state,
      reason: 'csrf_protection'
    });
    return res.redirect('/?error=invalid_state');
  }

  if (error) {
    logger.warn('OAuth callback error', {
      error,
      source: 'spotify'
    });
    return res.redirect('/?error=' + encodeURIComponent(error));
  }

  if (!code) {
    logger.warn('OAuth callback missing code', {
      query: req.query
    });
    return res.redirect('/?error=no_code');
  }

  logger.debug('OAuth callback: Exchanging code for tokens', {
    hasCode: true,
    redirectUri: process.env.SPOTIFY_REDIRECT_URI
  });

  const result = await exchangeCodeForTokens(code, process.env.SPOTIFY_REDIRECT_URI);
  
  if (result.success) {
    logger.info('OAuth callback: Success', {
      redirecting: 'home'
    });
    res.redirect('/?authenticated=true');
  } else {
    logger.warn('OAuth callback: Token exchange failed', {
      error: result.error
    });
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
      
      logger.debug('Spotify search error context', {
        endpoint: '/search',
        query: q,
        statusCode: response.status,
        clientIP,
        method: 'GET'
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

    logger.debug('Spotify search results', {
      query: q,
      resultCount: tracks.length,
      trackIds: tracks.map(t => t.id).slice(0, 5)
    });

    res.json({ tracks });
  } catch (err) {
    logger.error('Spotify search error', { 
      error: err.message, 
      query: q, 
      clientIP,
      stack: err.stack
    });
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

  try {
    // Check track limit per IP (only if enforcement is enabled)
    let currentCount = 0;
    if (enforceTrackLimits) {
      currentCount = db.getUserTrackCount(clientIP);
      if (currentCount >= MAX_TRACKS_PER_IP) {
        logger.warn('Track limit hit', {
          clientIP,
          currentCount,
          maxTracks: MAX_TRACKS_PER_IP,
          enforceTrackLimits
        });
        return res.status(429).json({ 
          error: `Track limit reached. You can only add ${MAX_TRACKS_PER_IP} tracks.`,
          remaining: 0
        });
      }
      
      // Log track limit check at verbose level
      logger.verbose('Track limit check', {
        clientIP,
        currentCount,
        maxTracks: MAX_TRACKS_PER_IP,
        remaining: MAX_TRACKS_PER_IP - currentCount,
        enforceTrackLimits
      });
    }

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
      // Store nickname if provided
      if (nickname) {
        const previousNickname = db.getUserNickname(clientIP);
        db.setUserNickname(clientIP, nickname);
        
        if (previousNickname && previousNickname !== nickname) {
          logger.verbose('Nickname updated', {
            clientIP,
            oldNickname: previousNickname,
            newNickname: nickname
          });
        } else if (!previousNickname) {
          logger.verbose('Nickname set', {
            clientIP,
            nickname
          });
        }
      }
      
      // Increment track count
      const newCount = db.incrementUserTrackCount(clientIP);
      
      // Add to party queue for voting display
      // Extract track ID from Spotify URI (format: spotify:track:XXXXX)
      const uriParts = uri.split(':');
      const trackId = uriParts.length >= 3 ? uriParts[2] : uri;
      
      if (trackId) {
        const track = {
          id: trackId,
          uri,
          name: name || 'Unknown',
          artist: artist || 'Unknown',
          albumArt: albumArt || null,
          addedBy: clientIP,
          addedByName: db.getUserNickname(clientIP) || nickname || 'Guest',
          addedAt: Date.now(),
          votes: 0
        };
        
        const added = db.addToPartyQueue(track);
        
        if (added) {
          logger.info('Party queue: Track added', {
            trackId,
            trackName: name,
            artistName: artist,
            addedByIP: clientIP,
            nickname: track.addedByName,
            queueSize: db.getPartyQueue().length,
            votesCount: 0,
            uri
          });
        }
      }
      
      logger.verbose('Track count updated', {
        clientIP,
        oldCount: currentCount,
        newCount: newCount,
        remaining: MAX_TRACKS_PER_IP - newCount,
        max: MAX_TRACKS_PER_IP,
        enforceTrackLimits
      });
      
      return res.json({ 
        success: true, 
        message: 'Track added to queue',
        remaining: MAX_TRACKS_PER_IP - newCount
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
    
    logger.debug('Spotify queue add error context', {
      uri,
      trackName: name,
      artistName: artist,
      clientIP,
      statusCode: response.status,
      method: 'POST'
    });
    
    return res.status(response.status).json({ error: errorMessage });
  } catch (err) {
    logger.error('Spotify queue error', { 
      error: err.message, 
      uri, 
      clientIP,
      stack: err.stack
    });
    res.status(500).json({ error: 'Failed to add track to queue' });
  }
});

// Get party queue with votes
app.get('/api/party-queue', (req, res) => {
  try {
    const clientIP = getClientIP(req);
    const queue = db.getPartyQueue();
    
    // Prevent browser caching of dynamic queue data
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    
    const currentCount = db.getUserTrackCount(clientIP);
    
    res.json({
      queue: queue.map(track => ({
        ...track,
        hasVoted: db.hasUserVoted(track.id, clientIP)
      })),
      remaining: enforceTrackLimits ? MAX_TRACKS_PER_IP - currentCount : -1,
      maxTracks: MAX_TRACKS_PER_IP,
      enforceTrackLimits: enforceTrackLimits
    });
  } catch (err) {
    logger.error('Failed to get party queue', { 
      error: err.message,
      stack: err.stack
    });
    res.status(500).json({ error: 'Failed to retrieve party queue' });
  }
});

// Vote for a track
app.post('/api/vote/:trackId', (req, res) => {
  const { trackId } = req.params;
  const clientIP = getClientIP(req);
  
  try {
    // Check if track exists in queue
    const queue = db.getPartyQueue();
    const track = queue.find(t => t.id === trackId);
    
    if (!track) {
      return res.status(404).json({ error: 'Track not found in queue' });
    }
    
    const hasVoted = db.hasUserVoted(trackId, clientIP);
    
    if (hasVoted) {
      // Remove vote
      db.removeVote(trackId, clientIP);
      const newVotes = db.getVotesForTrack(trackId);
      
      logger.info('Party queue: Vote removed', {
        trackId,
        trackName: track.name,
        voterIP: clientIP,
        action: 'remove',
        previousVoteCount: track.votes,
        newVoteCount: newVotes,
        artistName: track.artist
      });
      
      return res.json({ success: true, votes: newVotes, hasVoted: false });
    }
    
    // Add vote
    db.addVote(trackId, clientIP);
    const newVotes = db.getVotesForTrack(trackId);
    
    logger.info('Party queue: Vote added', {
      trackId,
      trackName: track.name,
      voterIP: clientIP,
      action: 'add',
      previousVoteCount: track.votes,
      newVoteCount: newVotes,
      artistName: track.artist
    });
    
    res.json({ success: true, votes: newVotes, hasVoted: true });
  } catch (err) {
    logger.error('Failed to process vote', { 
      error: err.message,
      trackId,
      clientIP,
      stack: err.stack
    });
    res.status(500).json({ error: 'Failed to process vote' });
  }
});

// Get remaining tracks for current user
app.get('/api/track-limit', (req, res) => {
  try {
    const clientIP = getClientIP(req);
    const currentCount = db.getUserTrackCount(clientIP);
    res.json({
      used: currentCount,
      remaining: enforceTrackLimits ? MAX_TRACKS_PER_IP - currentCount : -1,
      max: MAX_TRACKS_PER_IP,
      enforceTrackLimits: enforceTrackLimits
    });
  } catch (err) {
    logger.error('Failed to get track limit', { 
      error: err.message,
      stack: err.stack
    });
    res.status(500).json({ error: 'Failed to retrieve track limit' });
  }
});

// Get current playback state
app.get('/api/playback', ensureToken, async (req, res) => {
  try {
    // Check cache first
    const now = Date.now();
    const cacheAge = now - playbackCache.timestamp;
    const isCacheValid = playbackCache.data && cacheAge < playbackCache.ttl;
    
    if (isCacheValid) {
      logger.verbose('Playback cache hit', {
        cacheAgeMs: cacheAge,
        cacheAgeSeconds: Math.floor(cacheAge / 1000),
        ttlMs: playbackCache.ttl,
        ttlSeconds: playbackCache.ttl / 1000
      });
      return res.json(playbackCache.data);
    }
    
    logger.verbose('Playback cache miss', {
      reason: !playbackCache.data ? 'no_data' : 'expired',
      cacheAgeMs: cacheAge,
      ttlMs: playbackCache.ttl,
      lastUpdateTimestamp: playbackCache.timestamp
    });

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
      
      logger.verbose('Playback cache updated', {
        status: 'no_playback',
        cacheTimestamp: now
      });
      
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
    
    logger.verbose('Playback cache updated', {
      playing: result.playing,
      device: result.device,
      hasTrack: !!result.track,
      cacheTimestamp: now
    });
    
    res.json(result);
  } catch (err) {
    logger.error('Spotify playback state error', { 
      error: err.message,
      stack: err.stack,
      endpoint: '/me/player'
    });
    res.status(500).json({ error: 'Failed to get playback state' });
  }
});

/**
 * Get Spotify queue
 * Returns the current Spotify queue with track details
 * Uses caching with 15-second TTL to reduce API calls
 */
app.get('/api/spotify-queue', ensureToken, async (req, res) => {
  try {
    // Check cache first
    const now = Date.now();
    const cacheAge = now - spotifyQueueCache.timestamp;
    const isCacheValid = spotifyQueueCache.data && cacheAge < spotifyQueueCache.ttl;
    
    if (isCacheValid) {
      logger.verbose('Spotify queue cache hit', {
        cacheAgeMs: cacheAge,
        cacheAgeSeconds: Math.floor(cacheAge / 1000),
        ttlMs: spotifyQueueCache.ttl,
        ttlSeconds: spotifyQueueCache.ttl / 1000
      });
      return res.json(spotifyQueueCache.data);
    }
    
    logger.verbose('Spotify queue cache miss', {
      reason: !spotifyQueueCache.data ? 'no_data' : 'expired',
      cacheAgeMs: cacheAge,
      ttlMs: spotifyQueueCache.ttl,
      lastUpdateTimestamp: spotifyQueueCache.timestamp
    });

    const response = await spotifyFetch('/me/player/queue');

    logger.info('Spotify API: Get queue', {
      endpoint: '/me/player/queue',
      method: 'GET',
      statusCode: response.status
    });

    if (response.status === 404) {
      const result = { queue: [], currentlyPlaying: null };
      spotifyQueueCache.data = result;
      spotifyQueueCache.timestamp = now;
      
      logger.verbose('Spotify queue cache updated', {
        status: 'no_device',
        cacheTimestamp: now
      });
      
      return res.status(404).json({ error: 'No active device found. Please start playing on Spotify first.' });
    }

    if (!response.ok) {
      const errorMessage = await parseSpotifyErrorResponse(response, 'Failed to get queue');
      logger.error('Spotify API: Get queue failed', {
        endpoint: '/me/player/queue',
        statusCode: response.status,
        error: errorMessage
      });
      return res.status(response.status).json({ error: errorMessage });
    }

    const data = await response.json();
    
    // Format queue data
    const result = {
      currentlyPlaying: data.currently_playing ? {
        id: data.currently_playing.id,
        name: data.currently_playing.name,
        artist: data.currently_playing.artists?.map(a => a.name).join(', ') || 'Unknown',
        album: data.currently_playing.album?.name || '',
        albumArt: data.currently_playing.album?.images?.[0]?.url || null,
        duration: data.currently_playing.duration_ms
      } : null,
      queue: (data.queue || []).map(track => ({
        id: track.id,
        name: track.name,
        artist: track.artists?.map(a => a.name).join(', ') || 'Unknown',
        album: track.album?.name || '',
        albumArt: track.album?.images?.[0]?.url || null,
        duration: track.duration_ms
      }))
    };
    
    // Update cache
    spotifyQueueCache.data = result;
    spotifyQueueCache.timestamp = now;
    
    logger.verbose('Spotify queue cache updated', {
      queueLength: result.queue.length,
      hasCurrentlyPlaying: !!result.currentlyPlaying,
      cacheTimestamp: now
    });
    
    res.json(result);
  } catch (err) {
    logger.error('Spotify queue error', { 
      error: err.message,
      stack: err.stack,
      endpoint: '/me/player/queue'
    });
    res.status(500).json({ error: 'Failed to get Spotify queue' });
  }
});

// Logout (clear tokens)
app.post('/api/logout', (req, res) => {
  const hadTokens = {
    accessToken: !!tokenData.accessToken,
    refreshToken: !!tokenData.refreshToken,
    expiresAt: tokenData.expiresAt
  };
  
  tokenData = { accessToken: null, refreshToken: null, expiresAt: null };
  
  logger.info('User logged out', {
    clientIP: getClientIP(req),
    hadAccessToken: hadTokens.accessToken,
    hadRefreshToken: hadTokens.refreshToken
  });
  
  logger.verbose('Token storage cleared', {
    previousState: hadTokens,
    newState: { accessToken: null, refreshToken: null, expiresAt: null }
  });
  
  res.json({ success: true });
});

// Admin authentication middleware
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  const clientIP = getClientIP(req);
  
  if (!ADMIN_PASSWORD) {
    logger.warn('Admin access attempted but not configured', {
      endpoint: req.path,
      clientIP
    });
    return res.status(503).json({ error: 'Admin panel not configured. Set ADMIN_PASSWORD environment variable.' });
  }
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.verbose('Admin access denied: Missing authorization header', {
      endpoint: req.path,
      clientIP,
      hasHeader: !!authHeader
    });
    return res.status(401).json({ error: 'Admin authentication required' });
  }
  
  const token = authHeader.substring(7);
  
  try {
    const isValidSession = db.validateAdminSession(token);
    
    logger.verbose('Admin session validation', {
      endpoint: req.path,
      clientIP,
      isValidSession
    });
    
    if (!isValidSession) {
      logger.warn('Admin access denied: Invalid or expired session', {
        endpoint: req.path,
        clientIP
      });
      return res.status(403).json({ error: 'Invalid or expired admin session' });
    }
    
    next();
  } catch (err) {
    logger.error('Admin session validation error', { 
      error: err.message,
      stack: err.stack
    });
    return res.status(500).json({ error: 'Failed to validate admin session' });
  }
}

// Admin: Check if admin is configured
app.get('/api/admin/status', (req, res) => {
  res.json({ configured: !!ADMIN_PASSWORD });
});

// Admin: Verify credentials
app.post('/api/admin/login', authLimiter, (req, res) => {
  const { password } = req.body;
  const clientIP = getClientIP(req);
  
  logger.verbose('Admin login attempt', {
    clientIP,
    hasPassword: !!password,
    adminConfigured: !!ADMIN_PASSWORD
  });
  
  if (!ADMIN_PASSWORD) {
    logger.warn('Admin login attempted but not configured', { clientIP });
    return res.status(503).json({ error: 'Admin panel not configured' });
  }
  
  if (password === ADMIN_PASSWORD) {
    try {
      const token = generateAdminToken();
      db.createAdminSession(token);
      
      logger.info('Admin login successful', { 
        clientIP,
        sessionToken: token.substring(0, 8) + '...'
      });
      
      return res.json({ success: true, token });
    } catch (err) {
      logger.error('Failed to create admin session', { 
        error: err.message,
        clientIP,
        stack: err.stack
      });
      return res.status(500).json({ error: 'Failed to create admin session' });
    }
  }
  
  logger.warn('Admin login failed: invalid password', { 
    clientIP,
    attemptTimestamp: new Date().toISOString()
  });
  
  res.status(403).json({ error: 'Invalid password' });
});

// Admin: Skip current track
app.post('/api/admin/skip', requireAdmin, ensureToken, async (req, res) => {
  const clientIP = getClientIP(req);
  
  try {
    // Get current playback state for logging
    let currentTrack = null;
    try {
      const playbackResponse = await spotifyFetch('/me/player');
      if (playbackResponse.ok) {
        const playbackData = await playbackResponse.json();
        if (playbackData.item) {
          currentTrack = {
            name: playbackData.item.name,
            artist: playbackData.item.artists?.map(a => a.name).join(', ') || 'Unknown',
            id: playbackData.item.id
          };
        }
      }
    } catch (err) {
      logger.debug('Could not fetch current track for skip log', { error: err.message });
    }
    
    const response = await spotifyFetch('/me/player/next', {
      method: 'POST'
    });

    if (response.status === 204 || response.ok) {
      logger.info('Admin: Track skipped', { 
        action: 'skip',
        clientIP,
        statusCode: response.status,
        skippedTrack: currentTrack
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
    logger.error('Admin skip track error', { 
      error: err.message, 
      clientIP,
      stack: err.stack
    });
    res.status(500).json({ error: 'Failed to skip track' });
  }
});

// Admin: Remove track from party queue
app.delete('/api/admin/queue/:trackId', requireAdmin, (req, res) => {
  const { trackId } = req.params;
  const clientIP = getClientIP(req);
  
  try {
    // Get track info before removing
    const queue = db.getPartyQueue();
    const removedTrack = queue.find(t => t.id === trackId);
    
    if (!removedTrack) {
      return res.status(404).json({ error: 'Track not found in queue' });
    }
    
    const previousQueueSize = queue.length;
    const removed = db.removeFromPartyQueue(trackId);
    
    if (!removed) {
      logger.error('Failed to remove track from queue', {
        trackId,
        clientIP,
        reason: 'Database removal failed'
      });
      return res.status(500).json({ error: 'Failed to remove track from queue' });
    }
    
    // Get actual queue size after removal
    const newQueueSize = db.getPartyQueue().length;
    
    logger.info('Party queue: Track removed', {
      trackId,
      trackName: removedTrack.name,
      artistName: removedTrack.artist,
      removedBy: 'admin',
      removedByIP: clientIP,
      reason: 'admin_action',
      previousQueueSize,
      newQueueSize: newQueueSize,
      hadVotes: removedTrack.votes || 0
    });
    
    res.json({ success: true, message: 'Track removed from party queue' });
  } catch (err) {
    logger.error('Failed to remove track from queue', { 
      error: err.message,
      trackId,
      clientIP,
      stack: err.stack
    });
    res.status(500).json({ error: 'Failed to remove track from queue' });
  }
});

// Admin: Clear all party queue
app.delete('/api/admin/queue', requireAdmin, (req, res) => {
  const clientIP = getClientIP(req);
  
  try {
    const queue = db.getPartyQueue();
    const previousQueueSize = queue.length;
    const clearedTracks = db.clearPartyQueue();
    
    logger.info('Party queue: Cleared', {
      clearedBy: 'admin',
      clearedByIP: clientIP,
      reason: 'admin_action',
      tracksCleared: clearedTracks,
      previousQueueSize,
      newQueueSize: 0
    });
    
    res.json({ success: true, message: 'Party queue cleared' });
  } catch (err) {
    logger.error('Failed to clear party queue', { 
      error: err.message,
      clientIP,
      stack: err.stack
    });
    res.status(500).json({ error: 'Failed to clear party queue' });
  }
});

// Admin: Reset track limits for an IP or all
app.post('/api/admin/reset-limits', requireAdmin, (req, res) => {
  const ip = req.body?.ip;
  const clientIP = getClientIP(req);
  
  try {
    if (ip) {
      const previousCount = db.getUserTrackCount(ip);
      db.resetUserTrackCount(ip);
      
      logger.info('Track limit reset', {
        targetIP: ip,
        previousCount,
        newCount: 0,
        resetBy: 'admin',
        resetByIP: clientIP,
        reason: 'admin_action'
      });
      
      logger.verbose('IP track count changed', {
        ip,
        oldCount: previousCount,
        newCount: 0,
        action: 'reset',
        triggeredBy: 'admin'
      });
      
      res.json({ success: true, message: `Track limit reset for ${ip}` });
    } else {
      const allCounts = db.getAllTrackCounts();
      const totalIPs = Object.keys(allCounts).length;
      db.resetAllTrackCounts();
      
      logger.info('All track limits reset', {
        ipsCleared: totalIPs,
        resetBy: 'admin',
        resetByIP: clientIP,
        reason: 'admin_action'
      });
      
      logger.debug('Track limits cleared', {
        previousCounts: allCounts,
        clearedIPCount: totalIPs
      });
      
      res.json({ success: true, message: 'All track limits reset' });
    }
  } catch (err) {
    logger.error('Failed to reset track limits', { 
      error: err.message,
      clientIP,
      targetIP: ip,
      stack: err.stack
    });
    res.status(500).json({ error: 'Failed to reset track limits' });
  }
});

// Admin: Get all IPs with their track counts
app.get('/api/admin/track-limits', requireAdmin, (req, res) => {
  try {
    const limits = db.getAllTrackCounts();
    res.json({ limits });
  } catch (err) {
    logger.error('Failed to get track limits', { 
      error: err.message,
      stack: err.stack
    });
    res.status(500).json({ error: 'Failed to retrieve track limits' });
  }
});

// Admin: Pause playback
app.post('/api/admin/pause', requireAdmin, ensureToken, async (req, res) => {
  const clientIP = getClientIP(req);
  
  try {
    // Get current playback state for logging
    let currentTrack = null;
    try {
      const playbackResponse = await spotifyFetch('/me/player');
      if (playbackResponse.ok) {
        const playbackData = await playbackResponse.json();
        if (playbackData.item) {
          currentTrack = {
            name: playbackData.item.name,
            artist: playbackData.item.artists?.map(a => a.name).join(', ') || 'Unknown'
          };
        }
      }
    } catch (err) {
      logger.debug('Could not fetch current track for pause log', { error: err.message });
    }
    
    const response = await spotifyFetch('/me/player/pause', {
      method: 'PUT'
    });

    if (response.status === 204 || response.ok) {
      logger.info('Admin: Playback paused', {
        action: 'pause',
        clientIP,
        statusCode: response.status,
        pausedTrack: currentTrack
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
    logger.error('Admin pause playback error', { 
      error: err.message, 
      clientIP,
      stack: err.stack
    });
    res.status(500).json({ error: 'Failed to pause playback' });
  }
});

// Admin: Resume playback
app.post('/api/admin/play', requireAdmin, ensureToken, async (req, res) => {
  const clientIP = getClientIP(req);
  
  try {
    // Get current playback state for logging
    let currentTrack = null;
    try {
      const playbackResponse = await spotifyFetch('/me/player');
      if (playbackResponse.ok) {
        const playbackData = await playbackResponse.json();
        if (playbackData.item) {
          currentTrack = {
            name: playbackData.item.name,
            artist: playbackData.item.artists?.map(a => a.name).join(', ') || 'Unknown'
          };
        }
      }
    } catch (err) {
      logger.debug('Could not fetch current track for play log', { error: err.message });
    }
    
    const response = await spotifyFetch('/me/player/play', {
      method: 'PUT'
    });

    if (response.status === 204 || response.ok) {
      logger.info('Admin: Playback resumed', {
        action: 'play',
        clientIP,
        statusCode: response.status,
        resumedTrack: currentTrack
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
    logger.error('Admin resume playback error', { 
      error: err.message, 
      clientIP,
      stack: err.stack
    });
    res.status(500).json({ error: 'Failed to resume playback' });
  }
});

/**
 * Admin: Toggle track limit enforcement
 * Allows admin to dynamically enable/disable track limits
 */
app.post('/api/admin/toggle-limits', requireAdmin, (req, res) => {
  const clientIP = getClientIP(req);
  const { enabled } = req.body;
  const previousState = enforceTrackLimits;
  
  // If enabled is provided, set to that value; otherwise toggle
  if (typeof enabled === 'boolean') {
    enforceTrackLimits = enabled;
  } else {
    enforceTrackLimits = !enforceTrackLimits;
  }
  
  logger.info('Track limit enforcement toggled', {
    previousState,
    newState: enforceTrackLimits,
    toggledBy: 'admin',
    toggledByIP: clientIP,
    explicitValue: typeof enabled === 'boolean' ? enabled : 'toggled'
  });
  
  res.json({ 
    success: true, 
    enforceTrackLimits,
    message: enforceTrackLimits ? 'Track limits enabled' : 'Track limits disabled'
  });
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

// Initialize database before starting the server
try {
  db.initializeDatabase();
  logger.info('Database initialized successfully');
  
  // Schedule periodic cleanup of expired admin sessions (every hour)
  setInterval(() => {
    try {
      db.cleanupExpiredSessions();
    } catch (err) {
      logger.error('Failed to cleanup expired sessions', { 
        error: err.message 
      });
    }
  }, 60 * 60 * 1000); // 1 hour
} catch (err) {
  logger.error('Failed to initialize database', { 
    error: err.message,
    stack: err.stack
  });
  process.exit(1);
}

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
