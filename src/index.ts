import { createApp } from "./app.js";
import { resolveCallerByUsername } from "./auth/caller.js";
import { config } from "./config.js";
import { pool } from "./db/pool.js";

async function main(): Promise<void> {
  // Fail fast if the database is not reachable.
  await pool.query("SELECT 1");

  if (config.LOGIN_MODE === "dev") {
    console.error("WARNING: LOGIN_MODE=dev: any Saada Hisaab username + DEV_LOGIN_PASSWORD signs in. Dummy data only.");
  }
  let devShortcut = "off";
  if (config.DEV_ACCESS_KEY && config.DEV_USERNAME) {
    const devUser = await resolveCallerByUsername(config.DEV_USERNAME);
    devShortcut = `on: /mcp/<DEV_ACCESS_KEY> (${config.DEV_ACCESS_KEY.slice(0, 4)}…) acts as "${devUser.username}" of "${devUser.businessName}"`;
    console.error("WARNING: dev shortcut enabled (no sign-in). Remove DEV_ACCESS_KEY to turn it off.");
  }

  const app = createApp();
  // Express 5 calls this callback with an error too (e.g. port already in use).
  const httpServer = app.listen(config.PORT, config.HOST, (error?: Error) => {
    if (error) {
      const inUse = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
      console.error(
        inUse
          ? `Failed to start: port ${config.PORT} is already in use. Stop the other server (or change PORT in .env).`
          : `Failed to start: ${error.message}`,
      );
      process.exit(1);
    }
    console.error(`Saada Hisaab MCP server listening on ${config.HOST}:${config.PORT}`);
    console.error(`  MCP endpoint (OAuth): ${config.PUBLIC_BASE_URL}/mcp`);
    console.error(`  Sign-in: ${config.LOGIN_MODE === "api" ? "Saada Hisaab login API" : "dev password"}`);
    console.error(`  Dev shortcut: ${devShortcut}`);
    console.error(`  Database: ${config.PG_HOST}/${config.DB_NAME} (ssl: ${config.PG_SSL})`);
    console.error(`  Allowed hosts: ${config.ALLOWED_HOSTS.join(", ")}`);
  });

  const shutdown = () => {
    httpServer.close(() => void pool.end().finally(() => process.exit(0)));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`Failed to start: ${(err as Error).message}`);
  process.exit(1);
});
