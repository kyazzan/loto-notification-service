module.exports = {
  apps: [
    {
      name: 'notification-service',
      script: 'dist/server.js',
      env_file: '.env',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
