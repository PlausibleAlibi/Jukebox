// PM2 Ecosystem Configuration for Party Jukebox
// Usage: pm2 start ecosystem.config.js
// Setup: pm2 startup && pm2 save

module.exports = {
  apps: [
    {
      name: 'jukebox',
      script: 'server.js',
      cwd: '/opt/jukebox',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      env_file: '.env',
      error_file: '/var/log/jukebox/error.log',
      out_file: '/var/log/jukebox/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      // Restart on memory/cpu issues
      max_restarts: 10,
      restart_delay: 4000,
      // Health monitoring
      listen_timeout: 8000,
      kill_timeout: 5000
    }
  ]
};
