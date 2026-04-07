import { startServer } from "./server.js";

startServer().catch((err) => {
    console.error("[startup] Fatal error:", err);
    process.exit(1);
});
