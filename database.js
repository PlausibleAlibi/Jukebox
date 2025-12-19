const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

// Database configuration
const DATABASE_PATH = process.env.DATABASE_PATH || './data/jukebox.db';
const ADMIN_SESSION_EXPIRY = parseInt(process.env.ADMIN_SESSION_EXPIRY, 10) || 86400; // 24 hours in seconds

let db = null;

/**
 * Initialize database and create tables
 */
function initializeDatabase() {
  try {
    // Ensure data directory exists
    const dbDir = path.dirname(DATABASE_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      logger.info('Database directory created', { path: dbDir });
    }

    // Open database connection
    db = new Database(DATABASE_PATH);
    db.pragma('journal_mode = WAL'); // Write-Ahead Logging for better concurrency
    db.pragma('foreign_keys = ON');

    logger.info('Database connection established', { 
      path: DATABASE_PATH,
      journalMode: 'WAL'
    });

    // Create tables
    createTables();
    
    // Clean up expired admin sessions on startup
    cleanupExpiredSessions();
    
    logger.info('Database initialized successfully');
  } catch (err) {
    logger.error('Database initialization failed', { 
      error: err.message,
      stack: err.stack,
      path: DATABASE_PATH
    });
    throw err;
  }
}

/**
 * Create database tables and indexes
 */
function createTables() {
  const schema = `
    -- Party queue tracks
    CREATE TABLE IF NOT EXISTS party_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id TEXT NOT NULL,
      spotify_uri TEXT NOT NULL,
      name TEXT NOT NULL,
      artist TEXT NOT NULL,
      album_art TEXT,
      added_by_ip TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      nickname TEXT,
      UNIQUE(track_id, added_by_ip)
    );

    -- Track votes
    CREATE TABLE IF NOT EXISTS track_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id TEXT NOT NULL,
      voter_ip TEXT NOT NULL,
      voted_at INTEGER NOT NULL,
      UNIQUE(track_id, voter_ip)
    );

    -- User sessions (track counts and nicknames)
    CREATE TABLE IF NOT EXISTS user_sessions (
      ip_address TEXT PRIMARY KEY,
      track_count INTEGER DEFAULT 0,
      nickname TEXT,
      last_request INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Playback history (for analytics)
    CREATE TABLE IF NOT EXISTS playback_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id TEXT NOT NULL,
      spotify_uri TEXT NOT NULL,
      name TEXT NOT NULL,
      artist TEXT NOT NULL,
      added_by_ip TEXT,
      played_at INTEGER NOT NULL
    );

    -- Admin sessions (persistent admin tokens)
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_activity INTEGER NOT NULL
    );

    -- Create indexes for performance
    CREATE INDEX IF NOT EXISTS idx_party_queue_track_id ON party_queue(track_id);
    CREATE INDEX IF NOT EXISTS idx_party_queue_added_by ON party_queue(added_by_ip);
    CREATE INDEX IF NOT EXISTS idx_track_votes_track_id ON track_votes(track_id);
    CREATE INDEX IF NOT EXISTS idx_track_votes_voter_ip ON track_votes(voter_ip);
    CREATE INDEX IF NOT EXISTS idx_playback_history_played_at ON playback_history(played_at);
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at ON admin_sessions(expires_at);
  `;

  db.exec(schema);
  logger.info('Database schema created/verified');
}

// ============================================================================
// Party Queue Operations
// ============================================================================

/**
 * Add track to party queue
 * @param {Object} track - Track object with id, uri, name, artist, albumArt, addedBy, addedByName, addedAt
 * @returns {boolean} Success status (false if track already exists for this user)
 * @note Uses UNIQUE constraint on (track_id, added_by_ip) - same user can't add same track twice
 */
function addToPartyQueue(track) {
  try {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO party_queue (track_id, spotify_uri, name, artist, album_art, added_by_ip, added_at, nickname)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const result = stmt.run(
      track.id,
      track.uri,
      track.name,
      track.artist,
      track.albumArt || null,
      track.addedBy,
      track.addedAt,
      track.addedByName || null
    );
    
    const success = result.changes > 0;
    if (success) {
      logger.debug('Track added to party queue database', { 
        trackId: track.id,
        trackName: track.name,
        addedBy: track.addedBy
      });
    }
    
    return success;
  } catch (err) {
    logger.error('Failed to add track to party queue', { 
      error: err.message,
      trackId: track.id
    });
    throw err;
  }
}

/**
 * Get all party queue tracks with vote counts (sorted by votes desc)
 * @returns {Array} Array of track objects with vote counts
 */
function getPartyQueue() {
  try {
    const stmt = db.prepare(`
      SELECT 
        pq.track_id as id,
        pq.spotify_uri as uri,
        pq.name,
        pq.artist,
        pq.album_art as albumArt,
        pq.added_by_ip as addedBy,
        pq.nickname as addedByName,
        pq.added_at as addedAt,
        COUNT(tv.id) as votes
      FROM party_queue pq
      LEFT JOIN track_votes tv ON pq.track_id = tv.track_id
      GROUP BY pq.id
      ORDER BY votes DESC, pq.added_at ASC
    `);
    
    const tracks = stmt.all();
    
    logger.verbose('Party queue retrieved from database', { 
      trackCount: tracks.length
    });
    
    return tracks;
  } catch (err) {
    logger.error('Failed to get party queue', { error: err.message });
    throw err;
  }
}

/**
 * Remove specific track from party queue
 * @param {string} trackId - Spotify track ID
 * @returns {boolean} Success status
 */
function removeFromPartyQueue(trackId) {
  try {
    const deleteVotes = db.prepare('DELETE FROM track_votes WHERE track_id = ?');
    const deleteTrack = db.prepare('DELETE FROM party_queue WHERE track_id = ?');
    
    // Use transaction for atomicity
    const transaction = db.transaction(() => {
      deleteVotes.run(trackId);
      const result = deleteTrack.run(trackId);
      return result.changes > 0;
    });
    
    const success = transaction();
    
    if (success) {
      logger.debug('Track removed from party queue database', { trackId });
    }
    
    return success;
  } catch (err) {
    logger.error('Failed to remove track from party queue', { 
      error: err.message,
      trackId
    });
    throw err;
  }
}

/**
 * Clear all tracks from party queue
 * @returns {number} Number of tracks cleared
 */
function clearPartyQueue() {
  try {
    const deleteVotes = db.prepare('DELETE FROM track_votes');
    const deleteQueue = db.prepare('DELETE FROM party_queue');
    
    // Use transaction for atomicity
    const transaction = db.transaction(() => {
      deleteVotes.run();
      const result = deleteQueue.run();
      return result.changes;
    });
    
    const cleared = transaction();
    
    logger.debug('Party queue cleared from database', { tracksCleared: cleared });
    
    return cleared;
  } catch (err) {
    logger.error('Failed to clear party queue', { error: err.message });
    throw err;
  }
}

// ============================================================================
// Vote Operations
// ============================================================================

/**
 * Add vote for a track
 * @param {string} trackId - Spotify track ID
 * @param {string} voterIP - IP address of voter
 * @returns {boolean} Success status (false if already voted)
 */
function addVote(trackId, voterIP) {
  try {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO track_votes (track_id, voter_ip, voted_at)
      VALUES (?, ?, ?)
    `);
    
    const result = stmt.run(trackId, voterIP, Date.now());
    const success = result.changes > 0;
    
    if (success) {
      logger.debug('Vote added', { trackId, voterIP });
    }
    
    return success;
  } catch (err) {
    logger.error('Failed to add vote', { 
      error: err.message,
      trackId,
      voterIP
    });
    throw err;
  }
}

/**
 * Remove vote for a track
 * @param {string} trackId - Spotify track ID
 * @param {string} voterIP - IP address of voter
 * @returns {boolean} Success status
 */
function removeVote(trackId, voterIP) {
  try {
    const stmt = db.prepare(`
      DELETE FROM track_votes
      WHERE track_id = ? AND voter_ip = ?
    `);
    
    const result = stmt.run(trackId, voterIP);
    const success = result.changes > 0;
    
    if (success) {
      logger.debug('Vote removed', { trackId, voterIP });
    }
    
    return success;
  } catch (err) {
    logger.error('Failed to remove vote', { 
      error: err.message,
      trackId,
      voterIP
    });
    throw err;
  }
}

/**
 * Get vote count for a track
 * @param {string} trackId - Spotify track ID
 * @returns {number} Number of votes
 */
function getVotesForTrack(trackId) {
  try {
    const stmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM track_votes
      WHERE track_id = ?
    `);
    
    const result = stmt.get(trackId);
    return result.count;
  } catch (err) {
    logger.error('Failed to get votes for track', { 
      error: err.message,
      trackId
    });
    throw err;
  }
}

/**
 * Check if user has voted for a track
 * @param {string} trackId - Spotify track ID
 * @param {string} voterIP - IP address of voter
 * @returns {boolean} True if user has voted
 */
function hasUserVoted(trackId, voterIP) {
  try {
    const stmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM track_votes
      WHERE track_id = ? AND voter_ip = ?
    `);
    
    const result = stmt.get(trackId, voterIP);
    return result.count > 0;
  } catch (err) {
    logger.error('Failed to check if user voted', { 
      error: err.message,
      trackId,
      voterIP
    });
    throw err;
  }
}

// ============================================================================
// User Session Operations
// ============================================================================

/**
 * Get track count for an IP
 * @param {string} ip - IP address
 * @returns {number} Track count
 */
function getUserTrackCount(ip) {
  try {
    const stmt = db.prepare(`
      SELECT track_count
      FROM user_sessions
      WHERE ip_address = ?
    `);
    
    const result = stmt.get(ip);
    return result ? result.track_count : 0;
  } catch (err) {
    logger.error('Failed to get user track count', { 
      error: err.message,
      ip
    });
    throw err;
  }
}

/**
 * Increment track count for an IP
 * @param {string} ip - IP address
 * @returns {number} New track count
 */
function incrementUserTrackCount(ip) {
  try {
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO user_sessions (ip_address, track_count, last_request, updated_at)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(ip_address) DO UPDATE SET
        track_count = track_count + 1,
        last_request = excluded.last_request,
        updated_at = excluded.updated_at
    `);
    
    stmt.run(ip, now, now);
    
    const newCount = getUserTrackCount(ip);
    
    logger.debug('Track count incremented', { ip, newCount });
    
    return newCount;
  } catch (err) {
    logger.error('Failed to increment user track count', { 
      error: err.message,
      ip
    });
    throw err;
  }
}

/**
 * Reset track count for a specific IP
 * @param {string} ip - IP address
 * @returns {boolean} Success status
 */
function resetUserTrackCount(ip) {
  try {
    const stmt = db.prepare(`
      UPDATE user_sessions
      SET track_count = 0, updated_at = ?
      WHERE ip_address = ?
    `);
    
    const result = stmt.run(Date.now(), ip);
    const success = result.changes > 0;
    
    if (success) {
      logger.debug('Track count reset for user', { ip });
    }
    
    return success;
  } catch (err) {
    logger.error('Failed to reset user track count', { 
      error: err.message,
      ip
    });
    throw err;
  }
}

/**
 * Reset all track counts
 * @returns {number} Number of users reset
 */
function resetAllTrackCounts() {
  try {
    const stmt = db.prepare(`
      UPDATE user_sessions
      SET track_count = 0, updated_at = ?
    `);
    
    const result = stmt.run(Date.now());
    
    logger.debug('All track counts reset', { usersReset: result.changes });
    
    return result.changes;
  } catch (err) {
    logger.error('Failed to reset all track counts', { error: err.message });
    throw err;
  }
}

/**
 * Set or update nickname for an IP
 * @param {string} ip - IP address
 * @param {string} nickname - User nickname
 */
function setUserNickname(ip, nickname) {
  try {
    const now = Date.now();
    const stmt = db.prepare(`
      INSERT INTO user_sessions (ip_address, track_count, nickname, last_request, updated_at)
      VALUES (?, 0, ?, ?, ?)
      ON CONFLICT(ip_address) DO UPDATE SET
        nickname = excluded.nickname,
        last_request = excluded.last_request,
        updated_at = excluded.updated_at
    `);
    
    stmt.run(ip, nickname, now, now);
    
    logger.debug('Nickname set for user', { ip, nickname });
  } catch (err) {
    logger.error('Failed to set user nickname', { 
      error: err.message,
      ip,
      nickname
    });
    throw err;
  }
}

/**
 * Get nickname for an IP
 * @param {string} ip - IP address
 * @returns {string|null} Nickname or null
 */
function getUserNickname(ip) {
  try {
    const stmt = db.prepare(`
      SELECT nickname
      FROM user_sessions
      WHERE ip_address = ?
    `);
    
    const result = stmt.get(ip);
    return result ? result.nickname : null;
  } catch (err) {
    logger.error('Failed to get user nickname', { 
      error: err.message,
      ip
    });
    throw err;
  }
}

/**
 * Get all IP track counts
 * @returns {Object} Object mapping IP addresses to track counts
 */
function getAllTrackCounts() {
  try {
    const stmt = db.prepare(`
      SELECT ip_address, track_count
      FROM user_sessions
      WHERE track_count > 0
    `);
    
    const results = stmt.all();
    const counts = {};
    
    for (const row of results) {
      counts[row.ip_address] = row.track_count;
    }
    
    return counts;
  } catch (err) {
    logger.error('Failed to get all track counts', { error: err.message });
    throw err;
  }
}

// ============================================================================
// Admin Session Operations
// ============================================================================

/**
 * Create admin session
 * @param {string} token - Session token
 * @param {number} expiresIn - Expiry time in seconds (defaults to ADMIN_SESSION_EXPIRY)
 * @returns {boolean} Success status
 */
function createAdminSession(token, expiresIn = ADMIN_SESSION_EXPIRY) {
  try {
    const now = Date.now();
    const expiresAt = now + (expiresIn * 1000);
    
    const stmt = db.prepare(`
      INSERT INTO admin_sessions (token, created_at, expires_at, last_activity)
      VALUES (?, ?, ?, ?)
    `);
    
    stmt.run(token, now, expiresAt, now);
    
    logger.debug('Admin session created', { 
      token: token.substring(0, 8) + '...',
      expiresIn,
      expiresAt: new Date(expiresAt).toISOString()
    });
    
    return true;
  } catch (err) {
    logger.error('Failed to create admin session', { 
      error: err.message,
      token: token.substring(0, 8) + '...'
    });
    throw err;
  }
}

/**
 * Validate admin session token
 * @param {string} token - Session token
 * @returns {boolean} True if valid and not expired
 */
function validateAdminSession(token) {
  try {
    const now = Date.now();
    
    const stmt = db.prepare(`
      SELECT expires_at
      FROM admin_sessions
      WHERE token = ?
    `);
    
    const result = stmt.get(token);
    
    if (!result) {
      return false;
    }
    
    const isValid = result.expires_at > now;
    
    if (isValid) {
      // Update last activity
      const updateStmt = db.prepare(`
        UPDATE admin_sessions
        SET last_activity = ?
        WHERE token = ?
      `);
      updateStmt.run(now, token);
    } else {
      // Clean up expired session
      deleteAdminSession(token);
    }
    
    return isValid;
  } catch (err) {
    logger.error('Failed to validate admin session', { 
      error: err.message,
      token: token.substring(0, 8) + '...'
    });
    throw err;
  }
}

/**
 * Delete admin session
 * @param {string} token - Session token
 * @returns {boolean} Success status
 */
function deleteAdminSession(token) {
  try {
    const stmt = db.prepare(`
      DELETE FROM admin_sessions
      WHERE token = ?
    `);
    
    const result = stmt.run(token);
    const success = result.changes > 0;
    
    if (success) {
      logger.debug('Admin session deleted', { 
        token: token.substring(0, 8) + '...'
      });
    }
    
    return success;
  } catch (err) {
    logger.error('Failed to delete admin session', { 
      error: err.message,
      token: token.substring(0, 8) + '...'
    });
    throw err;
  }
}

/**
 * Clean up expired admin sessions
 * @returns {number} Number of sessions cleaned up
 */
function cleanupExpiredSessions() {
  try {
    const now = Date.now();
    
    const stmt = db.prepare(`
      DELETE FROM admin_sessions
      WHERE expires_at <= ?
    `);
    
    const result = stmt.run(now);
    
    if (result.changes > 0) {
      logger.info('Expired admin sessions cleaned up', { 
        sessionsRemoved: result.changes
      });
    }
    
    return result.changes;
  } catch (err) {
    logger.error('Failed to cleanup expired sessions', { error: err.message });
    throw err;
  }
}

// ============================================================================
// Playback History
// ============================================================================

/**
 * Add track to playback history
 * @param {Object} track - Track object
 * @param {number} playedAt - Timestamp when played
 */
function addToPlaybackHistory(track, playedAt = Date.now()) {
  try {
    const stmt = db.prepare(`
      INSERT INTO playback_history (track_id, spotify_uri, name, artist, added_by_ip, played_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      track.id || track.track_id,
      track.uri || track.spotify_uri,
      track.name,
      track.artist,
      track.addedBy || track.added_by_ip || null,
      playedAt
    );
    
    logger.debug('Track added to playback history', { 
      trackId: track.id || track.track_id,
      trackName: track.name,
      playedAt
    });
  } catch (err) {
    // Log at warning level since this affects analytics
    logger.warn('Failed to add to playback history', { 
      error: err.message,
      trackId: track.id || track.track_id
    });
    // Don't throw - playback history is not critical for app functionality
  }
}

// ============================================================================
// Analytics
// ============================================================================

/**
 * Get top requested tracks
 * @param {number} limit - Number of tracks to return
 * @returns {Array} Array of tracks with request counts
 */
function getTopRequestedTracks(limit = 10) {
  try {
    const stmt = db.prepare(`
      SELECT 
        track_id,
        name,
        artist,
        COUNT(*) as request_count
      FROM playback_history
      GROUP BY track_id
      ORDER BY request_count DESC
      LIMIT ?
    `);
    
    return stmt.all(limit);
  } catch (err) {
    logger.error('Failed to get top requested tracks', { error: err.message });
    throw err;
  }
}

/**
 * Get most active users by track count
 * @param {number} limit - Number of users to return
 * @returns {Array} Array of IPs with track counts
 */
function getMostActiveUsers(limit = 10) {
  try {
    const stmt = db.prepare(`
      SELECT 
        ip_address,
        track_count,
        nickname
      FROM user_sessions
      WHERE track_count > 0
      ORDER BY track_count DESC
      LIMIT ?
    `);
    
    return stmt.all(limit);
  } catch (err) {
    logger.error('Failed to get most active users', { error: err.message });
    throw err;
  }
}

/**
 * Get playback statistics
 * @returns {Object} Statistics object
 */
function getPlaybackStats() {
  try {
    const stmt = db.prepare(`
      SELECT 
        COUNT(DISTINCT track_id) as unique_tracks,
        COUNT(*) as total_plays,
        COUNT(DISTINCT added_by_ip) as unique_users
      FROM playback_history
    `);
    
    const queueStmt = db.prepare(`
      SELECT COUNT(*) as queue_size
      FROM party_queue
    `);
    
    const votesStmt = db.prepare(`
      SELECT COUNT(*) as total_votes
      FROM track_votes
    `);
    
    const stats = stmt.get();
    const queueStats = queueStmt.get();
    const voteStats = votesStmt.get();
    
    return {
      uniqueTracks: stats.unique_tracks,
      totalPlays: stats.total_plays,
      uniqueUsers: stats.unique_users,
      currentQueueSize: queueStats.queue_size,
      totalVotes: voteStats.total_votes
    };
  } catch (err) {
    logger.error('Failed to get playback stats', { error: err.message });
    throw err;
  }
}

/**
 * Close database connection
 */
function closeDatabase() {
  if (db) {
    db.close();
    logger.info('Database connection closed');
  }
}

// Export all functions
module.exports = {
  initializeDatabase,
  closeDatabase,
  
  // Party Queue
  addToPartyQueue,
  getPartyQueue,
  removeFromPartyQueue,
  clearPartyQueue,
  
  // Votes
  addVote,
  removeVote,
  getVotesForTrack,
  hasUserVoted,
  
  // User Sessions
  getUserTrackCount,
  incrementUserTrackCount,
  resetUserTrackCount,
  resetAllTrackCounts,
  setUserNickname,
  getUserNickname,
  getAllTrackCounts,
  
  // Admin Sessions
  createAdminSession,
  validateAdminSession,
  deleteAdminSession,
  cleanupExpiredSessions,
  
  // Playback History
  addToPlaybackHistory,
  
  // Analytics
  getTopRequestedTracks,
  getMostActiveUsers,
  getPlaybackStats
};
