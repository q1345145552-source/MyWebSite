import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface DbContext {
  db: DatabaseSync;
}

function dbFilePath(): string {
  const custom = process.env.SQLITE_PATH;
  if (custom?.trim()) return custom;
  return path.join(process.cwd(), "apps", "api", "data", "dev.sqlite");
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createDbContext(): DbContext {
  const file = dbFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  ensureSchema(db);
  ensureSeedData(db);
  ensureClientDemoOrders(db);
  return { db };
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      role TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      status TEXT NOT NULL,
      warehouse_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      warehouse_id TEXT NOT NULL,
      batch_no TEXT,
      order_no TEXT,
      approval_status TEXT NOT NULL DEFAULT 'approved',
      item_name TEXT NOT NULL,
      product_quantity INTEGER NOT NULL,
      package_count INTEGER NOT NULL,
      package_unit TEXT NOT NULL,
      weight_kg REAL,
      volume_m3 REAL,
      ship_date TEXT,
      domestic_tracking_no TEXT,
      transport_mode TEXT NOT NULL,
      receiver_name_th TEXT NOT NULL,
      receiver_phone_th TEXT NOT NULL,
      receiver_address_th TEXT NOT NULL,
      status_group TEXT NOT NULL DEFAULT 'unfinished',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shipments (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      tracking_no TEXT NOT NULL UNIQUE,
      batch_no TEXT,
      current_status TEXT NOT NULL,
      current_location TEXT,
      weight_kg REAL,
      volume_m3 REAL,
      package_count INTEGER,
      package_unit TEXT,
      transport_mode TEXT,
      domestic_tracking_no TEXT,
      warehouse_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS status_logs (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      shipment_id TEXT NOT NULL,
      operator_id TEXT NOT NULL,
      operator_role TEXT NOT NULL,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      remark TEXT,
      changed_at TEXT NOT NULL
    );
  `);
  ensureAdditionalColumns(db);
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function ensureAdditionalColumns(db: DatabaseSync): void {
  if (!hasColumn(db, "orders", "batch_no")) {
    db.exec("ALTER TABLE orders ADD COLUMN batch_no TEXT;");
  }
  if (!hasColumn(db, "orders", "approval_status")) {
    db.exec("ALTER TABLE orders ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved';");
  }
  if (!hasColumn(db, "shipments", "batch_no")) {
    db.exec("ALTER TABLE shipments ADD COLUMN batch_no TEXT;");
  }
  if (!hasColumn(db, "orders", "order_no")) {
    db.exec("ALTER TABLE orders ADD COLUMN order_no TEXT;");
  }
  if (!hasColumn(db, "orders", "weight_kg")) {
    db.exec("ALTER TABLE orders ADD COLUMN weight_kg REAL;");
  }
  if (!hasColumn(db, "orders", "volume_m3")) {
    db.exec("ALTER TABLE orders ADD COLUMN volume_m3 REAL;");
  }
  if (!hasColumn(db, "orders", "ship_date")) {
    db.exec("ALTER TABLE orders ADD COLUMN ship_date TEXT;");
  }
}

function ensureSeedData(db: DatabaseSync): void {
  const hasUsers = db.prepare("SELECT COUNT(1) as count FROM users").get() as { count: number };
  if (hasUsers.count > 0) return;

  const insertUser = db.prepare(`
    INSERT INTO users (id, company_id, role, name, phone, status, warehouse_ids, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertOrder = db.prepare(`
    INSERT INTO orders (
      id, company_id, client_id, warehouse_id, batch_no, order_no, approval_status, item_name, product_quantity, package_count, package_unit,
      weight_kg, volume_m3, ship_date, domestic_tracking_no, transport_mode, receiver_name_th, receiver_phone_th, receiver_address_th,
      status_group, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertShipment = db.prepare(`
    INSERT INTO shipments (
      id, company_id, order_id, tracking_no, batch_no, current_status, current_location, weight_kg, volume_m3,
      package_count, package_unit, transport_mode, domestic_tracking_no, warehouse_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = nowIso();
  insertUser.run("u_admin_001", "c_001", "admin", "Admin", "13000000001", "active", JSON.stringify([]), now);
  insertUser.run(
    "u_staff_001",
    "c_001",
    "staff",
    "Staff One",
    "13000000002",
    "active",
    JSON.stringify(["wh_bkk_01"]),
    now,
  );
  insertUser.run(
    "u_client_001",
    "c_001",
    "client",
    "Client One",
    "13000000003",
    "active",
    JSON.stringify([]),
    now,
  );

  insertOrder.run(
    "o_001",
    "c_001",
    "u_client_001",
    "wh_bkk_01",
    "CAB-2026-A01",
    "ORDER-2026-0001",
    "approved",
    "手机壳",
    200,
    12,
    "box",
    120.5,
    1.28,
    now.slice(0, 10),
    "SF12345678",
    "sea",
    "Somchai",
    "0812345678",
    "Bangkok",
    "unfinished",
    now,
    now,
  );

  insertShipment.run(
    "s_001",
    "c_001",
    "o_001",
    "THCN0001",
    "CAB-2026-A01",
    "inTransit",
    "Bangkok Hub",
    120.5,
    1.28,
    12,
    "box",
    "sea",
    "SF12345678",
    "wh_bkk_01",
    now,
    now,
  );
}

function ensureClientDemoOrders(db: DatabaseSync): void {
  const hasClient = db
    .prepare("SELECT COUNT(1) as count FROM users WHERE id = ? AND role = ?")
    .get("u_client_001", "client") as { count: number };
  if (hasClient.count === 0) return;

  const insertOrder = db.prepare(`
    INSERT OR IGNORE INTO orders (
      id, company_id, client_id, warehouse_id, batch_no, order_no, approval_status, item_name, product_quantity, package_count, package_unit,
      weight_kg, volume_m3, ship_date, domestic_tracking_no, transport_mode, receiver_name_th, receiver_phone_th, receiver_address_th,
      status_group, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertShipment = db.prepare(`
    INSERT OR IGNORE INTO shipments (
      id, company_id, order_id, tracking_no, batch_no, current_status, current_location, weight_kg, volume_m3,
      package_count, package_unit, transport_mode, domestic_tracking_no, warehouse_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const demoOrders = [
    {
      orderId: "o_001",
      orderNo: "ORDER-2026-0001",
      shipmentId: "s_001",
      batchNo: "CAB-2026-A01",
      itemName: "手机壳",
      productQuantity: 200,
      packageCount: 12,
      packageUnit: "box",
      domesticTrackingNo: "SF12345678",
      transportMode: "sea",
      receiverNameTh: "Somchai",
      receiverPhoneTh: "0812345678",
      receiverAddressTh: "Bangkok",
      trackingNo: "THCN0001",
      currentStatus: "inTransit",
      currentLocation: "Bangkok Hub",
      weightKg: 120.5,
      volumeM3: 1.28,
      statusGroup: "unfinished",
      minutesAgo: 30,
    },
    {
      orderId: "o_002",
      orderNo: "ORDER-2026-0002",
      shipmentId: "s_002",
      batchNo: "CAB-2026-A01",
      itemName: "蓝牙耳机",
      productQuantity: 180,
      packageCount: 6,
      packageUnit: "box",
      domesticTrackingNo: "YT99820001",
      transportMode: "land",
      receiverNameTh: "Anan",
      receiverPhoneTh: "0820000000",
      receiverAddressTh: "Chiang Mai",
      trackingNo: "THCN0002",
      currentStatus: "customsTH",
      currentLocation: "Bangkok Customs",
      weightKg: 86.2,
      volumeM3: 0.76,
      statusGroup: "unfinished",
      minutesAgo: 25,
    },
    {
      orderId: "o_003",
      orderNo: "ORDER-2026-0003",
      shipmentId: "s_003",
      batchNo: "CAB-2026-A02",
      itemName: "服装",
      productQuantity: 500,
      packageCount: 20,
      packageUnit: "bag",
      domesticTrackingNo: "ZT66009988",
      transportMode: "sea",
      receiverNameTh: "Niran",
      receiverPhoneTh: "0831112222",
      receiverAddressTh: "Pattaya",
      trackingNo: "THCN0003",
      currentStatus: "warehouseTH",
      currentLocation: "Pattaya Warehouse",
      weightKg: 210.0,
      volumeM3: 1.95,
      statusGroup: "unfinished",
      minutesAgo: 20,
    },
    {
      orderId: "o_004",
      orderNo: "ORDER-2026-0004",
      shipmentId: "s_004",
      batchNo: "CAB-2026-A02",
      itemName: "美妆套装",
      productQuantity: 160,
      packageCount: 8,
      packageUnit: "box",
      domesticTrackingNo: "JD55667788",
      transportMode: "land",
      receiverNameTh: "Kanya",
      receiverPhoneTh: "0899991111",
      receiverAddressTh: "Khon Kaen",
      trackingNo: "THCN0004",
      currentStatus: "delivered",
      currentLocation: "Khon Kaen",
      weightKg: 72.4,
      volumeM3: 0.61,
      statusGroup: "completed",
      minutesAgo: 15,
    },
    {
      orderId: "o_005",
      orderNo: "ORDER-2026-0005",
      shipmentId: "s_005",
      batchNo: "CAB-2026-A03",
      itemName: "家居收纳盒",
      productQuantity: 240,
      packageCount: 10,
      packageUnit: "box",
      domesticTrackingNo: "SF99887700",
      transportMode: "sea",
      receiverNameTh: "Prasert",
      receiverPhoneTh: "0862223333",
      receiverAddressTh: "Phuket",
      trackingNo: "THCN0005",
      currentStatus: "receivedCN",
      currentLocation: "Shenzhen Warehouse",
      weightKg: 98.1,
      volumeM3: 1.12,
      statusGroup: "unfinished",
      minutesAgo: 10,
    },
  ] as const;

  for (const item of demoOrders) {
    const createdAt = new Date(Date.now() - item.minutesAgo * 60 * 1000).toISOString();
    insertOrder.run(
      item.orderId,
      "c_001",
      "u_client_001",
      "wh_bkk_01",
      item.batchNo,
      item.orderNo,
      "approved",
      item.itemName,
      item.productQuantity,
      item.packageCount,
      item.packageUnit,
      item.weightKg,
      item.volumeM3,
      createdAt.slice(0, 10),
      item.domesticTrackingNo,
      item.transportMode,
      item.receiverNameTh,
      item.receiverPhoneTh,
      item.receiverAddressTh,
      item.statusGroup,
      createdAt,
      createdAt,
    );

    insertShipment.run(
      item.shipmentId,
      "c_001",
      item.orderId,
      item.trackingNo,
      item.batchNo,
      item.currentStatus,
      item.currentLocation,
      item.weightKg,
      item.volumeM3,
      item.packageCount,
      item.packageUnit,
      item.transportMode,
      item.domesticTrackingNo,
      "wh_bkk_01",
      createdAt,
      createdAt,
    );
  }
}
