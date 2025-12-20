const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Test database path
const TEST_DB_PATH = './data/test-jukebox.db';
process.env.DATABASE_PATH = TEST_DB_PATH;

// Import database module after setting env
const db = require('./database');

describe('Database Schema - camelCase Naming', () => {
  before(() => {
    // Clean up any existing test database
    const dbDir = path.dirname(TEST_DB_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    
    // Remove test database files if they exist
    [TEST_DB_PATH, TEST_DB_PATH + '-shm', TEST_DB_PATH + '-wal'].forEach(file => {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    });
    
    // Initialize database
    db.initializeDatabase();
  });

  after(() => {
    // Clean up test database
    db.closeDatabase();
    
    [TEST_DB_PATH, TEST_DB_PATH + '-shm', TEST_DB_PATH + '-wal'].forEach(file => {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    });
  });

  describe('Party Queue Operations', () => {
    it('should add track to party queue', () => {
      const track = {
        id: 'test123',
        uri: 'spotify:track:test123',
        name: 'Test Song',
        artist: 'Test Artist',
        albumArt: 'https://example.com/art.jpg',
        addedBy: '192.168.1.1',
        addedByName: 'TestUser',
        addedAt: Date.now()
      };
      
      const result = db.addToPartyQueue(track);
      assert.strictEqual(result, true, 'Should successfully add track');
    });

    it('should get party queue with camelCase properties', () => {
      const queue = db.getPartyQueue();
      
      assert.ok(Array.isArray(queue), 'Should return array');
      assert.ok(queue.length > 0, 'Queue should not be empty');
      
      const track = queue[0];
      // Verify camelCase properties exist
      assert.ok('id' in track, 'Should have id property');
      assert.ok('uri' in track, 'Should have uri property');
      assert.ok('albumArt' in track, 'Should have albumArt property');
      assert.ok('addedBy' in track, 'Should have addedBy property');
      assert.ok('addedByName' in track, 'Should have addedByName property');
      assert.ok('addedAt' in track, 'Should have addedAt property');
      assert.ok('votes' in track, 'Should have votes property');
    });

    it('should remove track from party queue', () => {
      const result = db.removeFromPartyQueue('test123');
      assert.strictEqual(result, true, 'Should successfully remove track');
    });
  });

  describe('Vote Operations', () => {
    before(() => {
      // Add a track for voting tests
      db.addToPartyQueue({
        id: 'vote-test',
        uri: 'spotify:track:vote-test',
        name: 'Vote Test Song',
        artist: 'Vote Test Artist',
        addedBy: '192.168.1.2',
        addedAt: Date.now()
      });
    });

    it('should add vote for track', () => {
      const result = db.addVote('vote-test', '192.168.1.3');
      assert.strictEqual(result, true, 'Should successfully add vote');
    });

    it('should get vote count for track', () => {
      const count = db.getVotesForTrack('vote-test');
      assert.strictEqual(count, 1, 'Should have 1 vote');
    });

    it('should check if user has voted', () => {
      const hasVoted = db.hasUserVoted('vote-test', '192.168.1.3');
      assert.strictEqual(hasVoted, true, 'Should return true for voted user');
      
      const hasNotVoted = db.hasUserVoted('vote-test', '192.168.1.99');
      assert.strictEqual(hasNotVoted, false, 'Should return false for non-voted user');
    });

    it('should remove vote for track', () => {
      const result = db.removeVote('vote-test', '192.168.1.3');
      assert.strictEqual(result, true, 'Should successfully remove vote');
      
      const count = db.getVotesForTrack('vote-test');
      assert.strictEqual(count, 0, 'Should have 0 votes after removal');
    });
  });

  describe('User Session Operations', () => {
    const testIp = '192.168.1.10';

    it('should increment user track count', () => {
      const count = db.incrementUserTrackCount(testIp);
      assert.strictEqual(count, 1, 'Should have count of 1');
      
      const count2 = db.incrementUserTrackCount(testIp);
      assert.strictEqual(count2, 2, 'Should have count of 2');
    });

    it('should get user track count', () => {
      const count = db.getUserTrackCount(testIp);
      assert.strictEqual(count, 2, 'Should return correct count');
    });

    it('should set user nickname', () => {
      db.setUserNickname(testIp, 'TestNickname');
      const nickname = db.getUserNickname(testIp);
      assert.strictEqual(nickname, 'TestNickname', 'Should return correct nickname');
    });

    it('should get all track counts with camelCase properties', () => {
      const counts = db.getAllTrackCounts();
      assert.ok(typeof counts === 'object', 'Should return object');
      assert.ok(testIp in counts, 'Should include test IP');
      assert.strictEqual(counts[testIp], 2, 'Should have correct count');
    });

    it('should reset user track count', () => {
      const result = db.resetUserTrackCount(testIp);
      assert.strictEqual(result, true, 'Should successfully reset');
      
      const count = db.getUserTrackCount(testIp);
      assert.strictEqual(count, 0, 'Count should be 0 after reset');
    });

    it('should reset all track counts', () => {
      db.incrementUserTrackCount('192.168.1.20');
      db.incrementUserTrackCount('192.168.1.21');
      
      const resetCount = db.resetAllTrackCounts();
      assert.ok(resetCount >= 2, 'Should reset at least 2 users');
    });
  });

  describe('Admin Session Operations', () => {
    const testToken = 'test-admin-token-123';

    it('should create admin session', () => {
      const result = db.createAdminSession(testToken, 3600);
      assert.strictEqual(result, true, 'Should successfully create session');
    });

    it('should validate admin session', () => {
      const isValid = db.validateAdminSession(testToken);
      assert.strictEqual(isValid, true, 'Should validate as true');
    });

    it('should delete admin session', () => {
      const result = db.deleteAdminSession(testToken);
      assert.strictEqual(result, true, 'Should successfully delete');
      
      const isValid = db.validateAdminSession(testToken);
      assert.strictEqual(isValid, false, 'Should no longer be valid');
    });

    it('should cleanup expired sessions', () => {
      // Create an expired session (expires in the past)
      const expiredToken = 'expired-token';
      const Database = require('better-sqlite3');
      const dbInstance = new Database(TEST_DB_PATH);
      
      const now = Date.now();
      const expiredTime = now - 1000; // 1 second in the past
      
      dbInstance.prepare(`
        INSERT INTO adminSessions (token, createdAt, expiresAt, lastActivity)
        VALUES (?, ?, ?, ?)
      `).run(expiredToken, now, expiredTime, now);
      
      dbInstance.close();
      
      const cleanedCount = db.cleanupExpiredSessions();
      assert.ok(cleanedCount >= 1, 'Should cleanup at least 1 expired session');
    });
  });

  describe('Playback History Operations', () => {
    it('should add track to playback history', () => {
      const track = {
        id: 'history-test',
        uri: 'spotify:track:history-test',
        name: 'History Test',
        artist: 'History Artist',
        addedBy: '192.168.1.30'
      };
      
      // Should not throw
      db.addToPlaybackHistory(track);
      assert.ok(true, 'Should add to history without error');
    });

    it('should get top requested tracks', () => {
      const topTracks = db.getTopRequestedTracks(5);
      assert.ok(Array.isArray(topTracks), 'Should return array');
    });

    it('should get most active users with camelCase properties', () => {
      const activeUsers = db.getMostActiveUsers(5);
      assert.ok(Array.isArray(activeUsers), 'Should return array');
      
      if (activeUsers.length > 0) {
        const user = activeUsers[0];
        assert.ok('ipAddress' in user, 'Should have ipAddress property');
        assert.ok('trackCount' in user, 'Should have trackCount property');
      }
    });

    it('should get playback stats', () => {
      const stats = db.getPlaybackStats();
      
      assert.ok(typeof stats === 'object', 'Should return object');
      assert.ok('uniqueTracks' in stats, 'Should have uniqueTracks');
      assert.ok('totalPlays' in stats, 'Should have totalPlays');
      assert.ok('uniqueUsers' in stats, 'Should have uniqueUsers');
      assert.ok('currentQueueSize' in stats, 'Should have currentQueueSize');
      assert.ok('totalVotes' in stats, 'Should have totalVotes');
    });
  });

  describe('Clear Operations', () => {
    it('should clear party queue', () => {
      // Add a track first
      db.addToPartyQueue({
        id: 'clear-test',
        uri: 'spotify:track:clear-test',
        name: 'Clear Test',
        artist: 'Clear Artist',
        addedBy: '192.168.1.40',
        addedAt: Date.now()
      });
      
      const cleared = db.clearPartyQueue();
      assert.ok(cleared >= 1, 'Should clear at least 1 track');
      
      const queue = db.getPartyQueue();
      assert.strictEqual(queue.length, 0, 'Queue should be empty after clear');
    });
  });
});

describe('Schema Migration', () => {
  it('should detect and migrate old snake_case schema', () => {
    // Clean up
    [TEST_DB_PATH, TEST_DB_PATH + '-shm', TEST_DB_PATH + '-wal'].forEach(file => {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    });
    
    // Create old schema
    const Database = require('better-sqlite3');
    const dbInstance = new Database(TEST_DB_PATH);
    
    dbInstance.exec(`
      CREATE TABLE party_queue (
        id INTEGER PRIMARY KEY,
        track_id TEXT,
        name TEXT
      )
    `);
    
    dbInstance.close();
    
    // Initialize - should migrate
    db.initializeDatabase();
    
    // Verify new schema exists
    const dbCheck = new Database(TEST_DB_PATH);
    const tables = dbCheck.prepare(`
      SELECT name FROM sqlite_master WHERE type='table'
    `).all();
    
    const tableNames = tables.map(t => t.name);
    
    // Should have new camelCase tables
    assert.ok(tableNames.includes('partyQueue'), 'Should have partyQueue table');
    assert.ok(tableNames.includes('trackVotes'), 'Should have trackVotes table');
    assert.ok(tableNames.includes('userSessions'), 'Should have userSessions table');
    
    // Should NOT have old snake_case tables
    assert.ok(!tableNames.includes('party_queue'), 'Should not have old party_queue table');
    
    dbCheck.close();
    db.closeDatabase();
  });
});
