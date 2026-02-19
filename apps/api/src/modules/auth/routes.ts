import type { DatabaseSync } from "node:sqlite";
import type { MinimalHttpApp } from "../../server";
import { fail, ok } from "../core/http-utils";

export function registerAuthRoutes(app: MinimalHttpApp, db: DatabaseSync): void {
  app.post("/auth/login", async (req, res) => {
    const body = (req.body ?? {}) as { account?: string; password?: string; role?: string };
    if (!body.account?.trim()) {
      fail(res, 400, "BAD_REQUEST", "account is required");
      return;
    }

    const queryById = db.prepare(
      "SELECT id, company_id, role, name FROM users WHERE id = ? AND status = 'active'",
    );
    const queryByRole = db.prepare(
      "SELECT id, company_id, role, name FROM users WHERE role = ? AND status = 'active' LIMIT 1",
    );
    const user =
      (queryById.get(body.account.trim()) as
        | { id: string; company_id: string; role: string; name: string }
        | undefined) ??
      (queryByRole.get((body.role ?? "client").trim()) as
        | { id: string; company_id: string; role: string; name: string }
        | undefined);

    if (!user) {
      fail(res, 401, "UNAUTHORIZED", "invalid credentials");
      return;
    }

    ok(res, {
      token: `mock_token_${user.id}`,
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        companyId: user.company_id,
      },
    });
  });
}
