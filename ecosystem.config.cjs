module.exports = {
  apps: [
    /* =========================
       API SERVER
    ========================== */
    {
      name: "erb-api",
      script: "./src/app.js",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      env: {
        NODE_ENV: "production",
        PORT: 8782,

        /* SMTP */
        SMTP_HOST: "relay.umcs.go.ug",
        SMTP_PORT: 587,
        SMTP_USER: "licenses@erb.go.ug",
        SMTP_PASS: process.env.SMTP_PASS,

        /* Redis */
        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: 6379,

        /* Database */
        DB_HOST: "localhost",
        DB_NAME: "erbdb",
        DB_USER: "erbadmin",
        DB_PASS: process.env.DB_PASS,

        /* File paths */
        SOURCE_DIR: "/var/ugpass/source",
        DEST_DIR: "/home/user1/ERB/registrad"
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      log_file: "./logs/api.log",
      error_file: "./logs/api-error.log",
      out_file: "./logs/api-out.log",
      autorestart: true
    },

    /* =========================
       EMAIL WORKER
    ========================== */
    {
      name: "erb-email-worker",
      script: "./src/workers/email_worker.js",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      env: {
        NODE_ENV: "production",

        SMTP_HOST: "relay.umcs.go.ug",
        SMTP_PORT: 587,
        SMTP_USER: "licenses@erb.go.ug",
        SMTP_PASS: process.env.SMTP_PASS,

        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: 6379
      },
      log_file: "./logs/email-worker.log",
      error_file: "./logs/email-worker-error.log",
      out_file: "./logs/email-worker-out.log",
      autorestart: true
    },

    /* =========================
       FILE PROCESS WORKER
       (Moves files source → registrad)
    ========================== */
    {
      name: "erb-file-process-worker",
      script: "./src/workers/file_process_worker.js",
      instances: 2,
      exec_mode: "fork",
      watch: false,
      env: {
        NODE_ENV: "production",

        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: 6379,

        DB_HOST: "localhost",
        DB_NAME: "erbdb",
        DB_USER: "erbadmin",
        DB_PASS: process.env.DB_PASS,

        SOURCE_DIR: "/var/ugpass/source",
        DEST_DIR: "/home/user1/ERB/registrad"
      },
      log_file: "./logs/file-process-worker.log",
      error_file: "./logs/file-process-worker-error.log",
      out_file: "./logs/file-process-worker-out.log",
      autorestart: true
    },

    /* =========================
       FILE MONITOR WORKER
       (DB updates / batch status)
    ========================== */
    {
      name: "erb-file-monitor-worker",
      script: "./src/workers/file_monitor_worker.js",
      instances: 2,
      exec_mode: "fork",
      watch: false,
      env: {
        NODE_ENV: "production",

        REDIS_HOST: "127.0.0.1",
        REDIS_PORT: 6379,

        DB_HOST: "localhost",
        DB_NAME: "erbdb",
        DB_USER: "erbadmin",
        DB_PASS: process.env.DB_PASS
      },
      log_file: "./logs/file-monitor-worker.log",
      error_file: "./logs/file-monitor-worker-error.log",
      out_file: "./logs/file-monitor-worker-out.log",
      autorestart: true
    }
  ]
};
