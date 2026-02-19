import { createDbContext } from "./db/sqlite";
import { registerAdminRoutes } from "./modules/admin/routes";
import { registerClientAiRoutes } from "./modules/ai";
import { registerAuthRoutes } from "./modules/auth/routes";
import { registerOrderRoutes } from "./modules/orders/routes";
import { registerShipmentRoutes } from "./modules/shipments/routes";
import { createApp } from "./server";

const PORT = Number(process.env.PORT ?? 3001);

const app = createApp();
const db = createDbContext();

// Core business routes
registerAuthRoutes(app, db.db);
registerOrderRoutes(app, db.db);
registerShipmentRoutes(app, db.db);
registerAdminRoutes(app, db.db);

// AI routes
registerClientAiRoutes(app);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[api] running on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log("[api] POST /auth/login");
  // eslint-disable-next-line no-console
  console.log("[api] POST /staff/orders");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /client/orders");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /client/shipments/search");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /staff/shipments");
  // eslint-disable-next-line no-console
  console.log("[api] POST /staff/shipments/update-status");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /admin/dashboard/overview");
  // eslint-disable-next-line no-console
  console.log("[api] POST /client/ai/chat");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /client/ai/suggestions");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /admin/ai/audit-logs");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /admin/system/status-labels");
  // eslint-disable-next-line no-console
  console.log("[api] POST /admin/system/status-labels");
  // eslint-disable-next-line no-console
  console.log("[api] POST /admin/system/status-labels/reset");
  // eslint-disable-next-line no-console
  console.log("[api] GET  /admin/ai/knowledge");
  // eslint-disable-next-line no-console
  console.log("[api] POST /admin/ai/knowledge");
  // eslint-disable-next-line no-console
  console.log("[api] DELETE /admin/ai/knowledge?id=kn_xxx");
});
