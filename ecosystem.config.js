module.exports = {
    apps: [
      {
        name: 'email-erb-api',
        script: './src/index.js',
        watch: false,
        env: {
          NODE_ENV: 'production',
          PORT: 8782,
          SMTP_HOST: 'relay.umcs.go.ug',
          SMTP_PORT: 587,
          SMTP_USER: 'licenses@erb.go.ug',
          SMTP_PASS: '081IZCno7sEghbh2LwbfGVtB',
          REDIS_HOST: '127.0.0.1',
          REDIS_PORT: 6379
        },
        log_file: './logs/api-combined.log',
        out_file: './logs/api-out.log',
        error_file: './logs/api-error.log',
        autorestart: true
      },
      {
        name: 'email-erb-worker',
        script: './src/workers/emailWorker.js',
        watch: false,
        env: {
          NODE_ENV: 'production',
          SMTP_HOST: 'relay.umcs.go.ug',
          SMTP_PORT: 587,
          SMTP_USER: 'licenses@erb.go.ug',
          SMTP_PASS: '081IZCno7sEghbh2LwbfGVtB',
          REDIS_HOST: '127.0.0.1',
          REDIS_PORT: 6379
        },
        log_file: './logs/worker-combined.log',
        out_file: './logs/worker-out.log',
        error_file: './logs/worker-error.log',
        autorestart: true
      }
    ]
  };
  