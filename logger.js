const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Log level from environment variable (default: 'info')
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// Custom format for console output
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...metadata }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(metadata).length > 0) {
      msg += ` ${JSON.stringify(metadata)}`;
    }
    return msg;
  })
);

// Format for file output (JSON for structured logging)
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json()
);

// Rotating file transport configuration
const fileRotateTransport = new DailyRotateFile({
  filename: path.join(logsDir, 'jukebox-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '14d',
  format: fileFormat
});

// Create logger instance
const logger = winston.createLogger({
  level: LOG_LEVEL,
  defaultMeta: { service: 'party-jukebox' },
  transports: [
    // Console transport
    new winston.transports.Console({
      format: consoleFormat
    }),
    // Rotating file transport
    fileRotateTransport
  ]
});

// Add error file transport for error-level logs only
const errorFileRotateTransport = new DailyRotateFile({
  filename: path.join(logsDir, 'jukebox-error-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '14d',
  level: 'error',
  format: fileFormat
});

logger.add(errorFileRotateTransport);

// Create a stream object for morgan HTTP logging
logger.stream = {
  write: (message) => {
    // Remove trailing newline from morgan output
    logger.info(message.trim(), { type: 'http' });
  }
};

module.exports = logger;
