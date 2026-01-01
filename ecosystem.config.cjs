module.exports = {
  apps: [
    /* =========================
       API SERVER
    ========================== */
    {
      name: "email-erb-api",
      script: "./src/index.js",
      watch: false,
      env: {
        NODE_ENV: "production",
        PORT: 8782,

        // SMTP
        SMTP_HOST: "relay.umcs.go.ug",
        SMTP_PORT: 587,
        SMTP_USER: "licenses@erb.go.ug",
        SMTP_PASS: process.env.SMTP_PASS,

        // Redis
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: 6379,

        // Database
        DB_HOST: "localhost",
        DB_NAME: "erbdb",
        DB_USER: "erbadmin",
        DB_PASS: process.env.DB_PASS
      },
      log_file: "./logs/api-combined.log",
      out_file: "./logs/api-out.log",
      error_file: "./logs/api-error.log",
      autorestart: true
    },

    /* =========================
       EMAIL WORKER
    ========================== */
    {
      name: "email-erb-worker",
      script: "./src/workers/email_worker.js",
      watch: false,
      env: {
        NODE_ENV: "production",

        // SMTP
        SMTP_HOST: "relay.umcs.go.ug",
        SMTP_PORT: 587,
        SMTP_USER: "licenses@erb.go.ug",
        SMTP_PASS: process.env.SMTP_PASS,

        // Redis
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: 6379
      },
      log_file: "./logs/email-worker-combined.log",
      out_file: "./logs/email-worker-out.log",
      error_file: "./logs/email-worker-error.log",
      autorestart: true
    },

    /* =========================
       FILE WORKER
    ========================== */
    {
      name: "file-erb-worker",
      script: "./src/workers/file_worker.js",
      watch: false,
      env: {
        NODE_ENV: "production",

        // Redis
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: 6379,

        // Database
        DB_HOST: "localhost",
        DB_NAME: "erbdb",
        DB_USER: "erbadmin",
        DB_PASS: process.env.DB_PASS,

        // File storage
        FILE_DIR: "/var/ugpass/source"
      },
      log_file: "./logs/file-worker-combined.log",
      out_file: "./logs/file-worker-out.log",
      error_file: "./logs/file-worker-error.log",
      autorestart: true
    }
  ]
};
