module.exports = {
  apps: [
    {
      name: "mmr-api",
      script: "./server.js",
      cwd: "/var/www/mmrcontructionsApi",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
        PORT: 5000
      }
    }
  ]
};
