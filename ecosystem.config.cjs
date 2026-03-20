module.exports = {
  apps: [
    {
      name: "btc-market",
      script: "npx",
      args: "tsx src/market.ts",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      env_file: ".env",
    },
  ],
};
