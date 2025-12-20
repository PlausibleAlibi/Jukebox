const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

// Database configuration
const DATABASE_PATH = process.env.DATABASE_PATH || './data/jukebox.db';
const ADMIN_SESSION_EXPIRY = parseInt(process.env.ADMIN_SESSION_EXPIRY, 10) || 86400; // 24 hours in seconds

let db = null;

/**
 * Check for old snake_case schema and migrate to camelCase
 */
function migrateFromOldSchema() {
  try {
    // Check if old schema exists by looking for the old table name
    const tableCheck = db.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name='party_queue'
    `).get();
    
    if (tableCheck) {
      logger.warn('Old snake_case database schema detected - migrating to camelCase naming');
      logger.info('Dropping old tables and recreating with new schema');
      
      // Drop all old tables
      const oldTables = ['party_queue', 'track_votes', 'user_sessions', 'playback_history', 'admin_sessions'];
      for (const table of oldTables) {
        try {
          db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
          logger.debug(`Dropped old table: ${table}`);
        } catch (err) {
          logger.warn(`Failed to drop table ${table}`, { error: err.message });
        }
      }
      
      logger.info('Old schema migration complete - new tables will be created with camelCase names');
    }
  } catch (err) {
    logger.error('Schema migration check failed', { error: err.message });
    throw err;
  }
}

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

    // Check for old schema and migrate if needed
    migrateFromOldSchema();

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
    -- Note: UNIQUE constraint on (trackId, addedByIp) prevents same user from adding same track twice
    CREATE TABLE IF NOT EXISTS partyQueue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trackId TEXT NOT NULL,
      spotifyUri TEXT NOT NULL,
      name TEXT NOT NULL,
      artist TEXT NOT NULL,
      albumArt TEXT,
      addedByIp TEXT NOT NULL,
      addedAt INTEGER NOT NULL,
      nickname TEXT,
      UNIQUE(trackId, addedByIp)
    );

    -- Track votes
    CREATE TABLE IF NOT EXISTS trackVotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trackId TEXT NOT NULL,
      voterIp TEXT NOT NULL,
      votedAt INTEGER NOT NULL,
      UNIQUE(trackId, voterIp)
    );

    -- User sessions (track counts and nicknames)
    CREATE TABLE IF NOT EXISTS userSessions (
      ipAddress TEXT PRIMARY KEY,
      trackCount INTEGER DEFAULT 0,
      nickname TEXT,
      lastRequest INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    -- Playback history (for analytics)
    CREATE TABLE IF NOT EXISTS playbackHistory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trackId TEXT NOT NULL,
      spotifyUri TEXT NOT NULL,
      name TEXT NOT NULL,
      artist TEXT NOT NULL,
      addedByIp TEXT,
      playedAt INTEGER NOT NULL
    );

    -- Admin sessions (persistent admin tokens)
    CREATE TABLE IF NOT EXISTS adminSessions (
      token TEXT PRIMARY KEY,
      createdAt INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL,
      lastActivity INTEGER NOT NULL
    );

    -- Create indexes for performance
    CREATE INDEX IF NOT EXISTS idxPartyQueueTrackId ON partyQueue(trackId);
    CREATE INDEX IF NOT EXISTS idxPartyQueueAddedBy ON partyQueue(addedByIp);
    CREATE INDEX IF NOT EXISTS idxTrackVotesTrackId ON trackVotes(trackId);
    CREATE INDEX IF NOT EXISTS idxTrackVotesVoterIp ON trackVotes(voterIp);
    CREATE INDEX IF NOT EXISTS idxPlaybackHistoryPlayedAt ON playbackHistory(playedAt);
    CREATE INDEX IF NOT EXISTS idxAdminSessionsExpiresAt ON adminSessions(expiresAt);
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
 * @note Uses UNIQUE constraint on (trackId, addedByIp) - same user can't add same track twice
 */
function addToPartyQueue(track) {
  try {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO partyQueue (trackId, spotifyUri, name, artist, albumArt, addedByIp, addedAt, nickname)
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
        pq.trackId as id,
        pq.spotifyUri as uri,
        pq.name,
        pq.artist,
        pq.albumArt as albumArt,
        pq.addedByIp as addedBy,
        pq.nickname as addedByName,
        pq.addedAt as addedAt,
        COUNT(tv.id) as votes
      FROM partyQueue pq
      LEFT JOIN trackVotes tv ON pq.trackId = tv.trackId
      GROUP BY pq.id
      ORDER BY votes DESC, pq.addedAt ASC
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
    const deleteVotes = db.prepare('DELETE FROM trackVotes WHERE trackId = ?');
    const deleteTrack = db.prepare('DELETE FROM partyQueue WHERE trackId = ?');
    
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
    const deleteVotes = db.prepare('DELETE FROM trackVotes');
    const deleteQueue = db.prepare('DELETE FROM partyQueue');
    
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
      INSERT OR IGNORE INTO trackVotes (trackId, voterIp, votedAt)
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
      DELETE FROM trackVotes
      WHERE trackId = ? AND voterIp = ?
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
      FROM trackVotes
      WHERE trackId = ?
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
      FROM trackVotes
      WHERE trackId = ? AND voterIp = ?
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
      SELECT trackCount
      FROM userSessions
      WHERE ipAddress = ?
    `);
    
    const result = stmt.get(ip);
    return result ? result.trackCount : 0;
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
      INSERT INTO userSessions (ipAddress, trackCount, lastRequest, updatedAt)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(ipAddress) DO UPDATE SET
        trackCount = trackCount + 1,
        lastRequest = excluded.lastRequest,
        updatedAt = excluded.updatedAt
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
      UPDATE userSessions
      SET trackCount = 0, updatedAt = ?
      WHERE ipAddress = ?
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
      UPDATE userSessions
      SET trackCount = 0, updatedAt = ?
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
      INSERT INTO userSessions (ipAddress, trackCount, nickname, lastRequest, updatedAt)
      VALUES (?, 0, ?, ?, ?)
      ON CONFLICT(ipAddress) DO UPDATE SET
        nickname = excluded.nickname,
        lastRequest = excluded.lastRequest,
        updatedAt = excluded.updatedAt
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
      FROM userSessions
      WHERE ipAddress = ?
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
      SELECT ipAddress, trackCount
      FROM userSessions
      WHERE trackCount > 0
    `);
    
    const results = stmt.all();
    const counts = {};
    
    for (const row of results) {
      counts[row.ipAddress] = row.trackCount;
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
      INSERT INTO adminSessions (token, createdAt, expiresAt, lastActivity)
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
      SELECT expiresAt
      FROM adminSessions
      WHERE token = ?
    `);
    
    const result = stmt.get(token);
    
    if (!result) {
      return false;
    }
    
    const isValid = result.expiresAt > now;
    
    if (isValid) {
      // Update last activity
      const updateStmt = db.prepare(`
        UPDATE adminSessions
        SET lastActivity = ?
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
      DELETE FROM adminSessions
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
      DELETE FROM adminSessions
      WHERE expiresAt <= ?
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
 * Note: This is a non-critical operation for analytics purposes only.
 * Failures are logged at warning level but don't affect core app functionality.
 * @param {Object} track - Track object
 * @param {number} playedAt - Timestamp when played
 */
function addToPlaybackHistory(track, playedAt = Date.now()) {
  try {
    const stmt = db.prepare(`
      INSERT INTO playbackHistory (trackId, spotifyUri, name, artist, addedByIp, playedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      track.id || track.trackId,
      track.uri || track.spotifyUri,
      track.name,
      track.artist,
      track.addedBy || track.addedByIp || null,
      playedAt
    );
    
    logger.debug('Track added to playback history', { 
      trackId: track.id || track.trackId,
      trackName: track.name,
      playedAt
    });
  } catch (err) {
    // Log at warning level since this affects analytics, but is not critical for app operation
    // Playback history is used for statistics only and its absence doesn't impact core features
    logger.warn('Failed to add to playback history', { 
      error: err.message,
      trackId: track.id || track.trackId
    });
    // Don't throw - playback history is not critical for app functionality
  }
}

// ============================================================================
// Analytics
// ============================================================================

/**
 * Get the most requested tracks across all time
 * @param {number} limit - Number of results to return (default: 10)
 * @returns {Array} Array of tracks with request count
 */
function getTopRequestedTracks(limit = 10) {
  try {
    const stmt = db.prepare(`
      SELECT 
        trackId,
        name,
        artist,
        albumArt,
        spotifyUri,
        COUNT(*) as requestCount
      FROM partyQueue
      GROUP BY trackId
      ORDER BY requestCount DESC
      LIMIT ?
    `);
    
    const tracks = stmt.all(limit);
    logger.verbose('Top requested tracks retrieved', { count: tracks.length });
    return tracks;
  } catch (err) {
    logger.error('Failed to get top requested tracks', { error: err.message });
    throw err;
  }
}

/**
 * Get the most active users by track submission count
 * @param {number} limit - Number of results to return (default: 10)
 * @returns {Array} Array of users with submission count
 */
function getMostActiveUsers(limit = 10) {
  try {
    const stmt = db.prepare(`
      SELECT 
        ipAddress,
        nickname,
        trackCount
      FROM userSessions
      WHERE trackCount > 0
      ORDER BY trackCount DESC
      LIMIT ?
    `);
    
    const users = stmt.all(limit);
    logger.verbose('Most active users retrieved', { count: users.length });
    return users;
  } catch (err) {
    logger.error('Failed to get most active users', { error: err.message });
    throw err;
  }
}

/**
 * Get total number of votes cast across all tracks
 * @returns {number} Total vote count
 */
function getTotalVotesCast() {
  try {
    const stmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM trackVotes
    `);
    
    const result = stmt.get();
    const count = result.count;
    logger.verbose('Total votes cast retrieved', { count });
    return count;
  } catch (err) {
    logger.error('Failed to get total votes cast', { error: err.message });
    throw err;
  }
}

/**
 * Get peak usage statistics by hour of day
 * @returns {Array} Array of hour stats with track counts
 */
function getPeakUsageByHour() {
  try {
    const stmt = db.prepare(`
      SELECT 
        CAST(strftime('%H', datetime(addedAt / 1000, 'unixepoch')) AS INTEGER) as hour,
        COUNT(*) as trackCount
      FROM partyQueue
      GROUP BY hour
      ORDER BY hour
    `);
    
    const hourlyStats = stmt.all();
    logger.verbose('Peak usage by hour retrieved', { hours: hourlyStats.length });
    return hourlyStats;
  } catch (err) {
    logger.error('Failed to get peak usage by hour', { error: err.message });
    throw err;
  }
}

/**
 * Get overall party statistics
 * @returns {Object} Statistics object with various metrics
 */
function getGeneralStats() {
  try {
    // Total tracks in queue
    const queueStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM partyQueue
    `);
    const queueResult = queueStmt.get();
    
    // Total users
    const usersStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM userSessions
    `);
    const usersResult = usersStmt.get();
    
    // Total votes
    const votesStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM trackVotes
    `);
    const votesResult = votesStmt.get();
    
    // Total tracks played
    const playedStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM playbackHistory
    `);
    const playedResult = playedStmt.get();
    
    // Most voted track
    const mostVotedStmt = db.prepare(`
      SELECT 
        pq.trackId,
        pq.name,
        pq.artist,
        COUNT(tv.id) as votes
      FROM partyQueue pq
      LEFT JOIN trackVotes tv ON pq.trackId = tv.trackId
      GROUP BY pq.trackId
      ORDER BY votes DESC
      LIMIT 1
    `);
    const mostVotedResult = mostVotedStmt.get();
    
    const stats = {
      totalTracksInQueue: queueResult.count,
      totalUsers: usersResult.count,
      totalVotes: votesResult.count,
      totalTracksPlayed: playedResult.count,
      mostVotedTrack: mostVotedResult && mostVotedResult.votes > 0 ? {
        trackId: mostVotedResult.trackId,
        name: mostVotedResult.name,
        artist: mostVotedResult.artist,
        votes: mostVotedResult.votes
      } : null
    };
    
    logger.verbose('General stats retrieved', stats);
    return stats;
  } catch (err) {
    logger.error('Failed to get general stats', { error: err.message });
    throw err;
  }
}

/**
 * Get statistics for a specific user by IP
 * @param {string} ipAddress - User's IP address
 * @returns {Object} User statistics
 */
function getUserStats(ipAddress) {
  try {
    // Get user session data
    const userStmt = db.prepare(`
      SELECT 
        ipAddress,
        nickname,
        trackCount,
        lastRequest
      FROM userSessions
      WHERE ipAddress = ?
    `);
    const userResult = userStmt.get(ipAddress);
    
    if (!userResult) {
      return null;
    }
    
    // Count votes cast by this IP
    const votesStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM trackVotes
      WHERE voterIp = ?
    `);
    const votesResult = votesStmt.get(ipAddress);
    
    // Count tracks currently in queue by this IP
    const queueStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM partyQueue
      WHERE addedByIp = ?
    `);
    const queueResult = queueStmt.get(ipAddress);
    
    const stats = {
      ipAddress: userResult.ipAddress,
      nickname: userResult.nickname || null,
      totalTracksAdded: userResult.trackCount,
      totalVotesCast: votesResult.count,
      currentTracksInQueue: queueResult.count,
      lastActive: userResult.lastRequest
    };
    
    logger.verbose('User stats retrieved', { ipAddress, stats });
    return stats;
  } catch (err) {
    logger.error('Failed to get user stats', { error: err.message, ipAddress });
    throw err;
  }
}

/**
 * Get playback statistics
 * @returns {Object} Statistics object
 * @deprecated Use getGeneralStats() instead for comprehensive statistics
 */
function getPlaybackStats() {
  try {
    const stmt = db.prepare(`
      SELECT 
        COUNT(DISTINCT trackId) as unique_tracks,
        COUNT(*) as total_plays,
        COUNT(DISTINCT addedByIp) as unique_users
      FROM playbackHistory
    `);
    
    const queueStmt = db.prepare(`
      SELECT COUNT(*) as queue_size
      FROM partyQueue
    `);
    
    const votesStmt = db.prepare(`
      SELECT COUNT(*) as total_votes
      FROM trackVotes
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
  getTotalVotesCast,
  getPeakUsageByHour,
  getGeneralStats,
  getUserStats,
  getPlaybackStats
};
