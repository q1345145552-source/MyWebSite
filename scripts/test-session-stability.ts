/**
 * 登录入口与跨标签会话稳定性：直接调用浏览器会话模块，不复制被测逻辑。
 * Map 实现 localStorage，覆盖多账号缓存、旧 key、坏 JSON 和存储异常。
 * 这里只验证客户端状态，不模拟服务端登录、JWT 校验，不连 API 或数据库。
 */
import assert from "node:assert/strict";
import {
  clearAuthSession,
  clearClientOrderCaches,
  getOptionalSession,
  prepareLoginPage,
  setAuthSession,
  type AuthRole,
  type AuthSession,
} from "../apps/web/src/auth/auth-session";

const SESSION_KEY = "auth_session_v1";
const LEGACY_KEY = "mock_session_v1";
const ROLES: readonly AuthRole[] = ["admin", "staff", "client"];
type StorageOperation = "getItem" | "setItem" | "removeItem" | "key" | "length";

class MemoryStorage implements Storage {
  private readonly values: Map<string, string>;
  readonly mutations: Array<{ operation: "setItem" | "removeItem" | "clear"; key?: string }> = [];

  constructor(entries: Record<string, string> = {}, private readonly blocked?: StorageOperation) {
    this.values = new Map(Object.entries(entries));
  }

  private check(operation: StorageOperation): void {
    if (this.blocked === operation) throw new Error(`Synthetic storage ${operation} failure`);
  }

  get length(): number {
    this.check("length");
    return this.values.size;
  }

  key(index: number): string | null {
    this.check("key");
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    this.check("getItem");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.check("setItem");
    this.mutations.push({ operation: "setItem", key });
    this.values.set(String(key), String(value));
  }

  removeItem(key: string): void {
    this.check("removeItem");
    this.mutations.push({ operation: "removeItem", key });
    this.values.delete(key);
  }

  clear(): void {
    this.mutations.push({ operation: "clear" });
    this.values.clear();
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries([...this.values.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
}

function session(role: AuthRole, suffix = "current"): AuthSession {
  return { userId: `fixture-${role}-${suffix}`, companyId: "fixture-company", role, token: `client-state-fixture-${role}-${suffix}` };
}

function restoreWindow(descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
  else Reflect.deleteProperty(globalThis, "window");
}

function withWindow(windowValue: object, body: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowValue });
  try { body(); } finally { restoreWindow(previous); }
}

function withStorage(storage: MemoryStorage, body: () => void): void {
  withWindow({ localStorage: storage }, body);
}

const failures: string[] = [];
let checks = 0;
function check(name: string, body: () => void): void {
  checks++;
  try {
    body();
    console.log(`  ✅ ${checks}) ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  ❌ ${checks}) ${name}\n     ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log("登录入口与客户端会话稳定性（真实函数；合成 localStorage；不连 API/数据库）");

for (const role of ROLES) {
  check(`${role} 已有会话：反复准备登录页既不注销，也不写凭证/删缓存`, () => {
    const current = session(role);
    const storage = new MemoryStorage({
      [SESSION_KEY]: JSON.stringify(current), [LEGACY_KEY]: JSON.stringify(session("client", "older")),
      xt_orders_customer_a: "cached-a", xt_orders_customer_b: "cached-b", theme: "neutral",
    });
    const before = storage.snapshot();
    withStorage(storage, () => {
      for (let i = 0; i < 3; i++) prepareLoginPage();
      assert.deepEqual(getOptionalSession(), current);
      assert.deepEqual(storage.snapshot(), before, "打开另一个登录标签不应清掉工作台会话或客户缓存");
      assert.deepEqual(storage.mutations, [], "已有新 key 会话时，入口准备必须只读");
    });
  });
}

check("匿名入口清全部客户订单缓存，但不动外观及相似非前缀 key；重复执行幂等", () => {
  const unrelated = { theme: "neutral", xt_orders: "not-the-cache-prefix", prefix_xt_orders_a: "unrelated", remember_account: "fixture" };
  const storage = new MemoryStorage({ ...unrelated, xt_orders_a: "one", xt_orders_b: "two", xt_orders_c: "three" });
  withStorage(storage, () => {
    prepareLoginPage(); prepareLoginPage();
    assert.equal(getOptionalSession(), null);
    assert.deepEqual(storage.snapshot(), unrelated);
  });
});

for (const [name, raw] of [
  ["坏 JSON", "{broken"], ["null JSON", "null"], ["缺全部字段", "{}"],
  ["缺 token", JSON.stringify({ ...session("client"), token: "" })],
]) {
  check(`匿名入口遇到${name}时清坏凭证与旧客户缓存，不复活遗留会话`, () => {
    const storage = new MemoryStorage({ [SESSION_KEY]: raw, [LEGACY_KEY]: "{also-broken", xt_orders_a: "stale", theme: "neutral" });
    withStorage(storage, () => {
      prepareLoginPage();
      assert.equal(getOptionalSession(), null);
      assert.deepEqual(storage.snapshot(), { theme: "neutral" });
    });
  });
}

check("只剩坏的旧 key 时也清理，不让下次读取重新迁入坏会话", () => {
  const storage = new MemoryStorage({ [LEGACY_KEY]: "{broken", xt_orders_a: "stale", theme: "neutral" });
  withStorage(storage, () => {
    prepareLoginPage();
    assert.equal(getOptionalSession(), null);
    assert.deepEqual(storage.snapshot(), { theme: "neutral" });
  });
});

check("可读旧 key 仍按现有规则迁移，登录入口保留该会话及缓存", () => {
  const current = session("staff", "legacy");
  const storage = new MemoryStorage({ [LEGACY_KEY]: JSON.stringify(current), xt_orders_a: "cached", theme: "neutral" });
  withStorage(storage, () => {
    prepareLoginPage();
    assert.deepEqual(getOptionalSession(), current);
    assert.equal(storage.getItem(SESSION_KEY), JSON.stringify(current));
    assert.equal(storage.getItem(LEGACY_KEY), null);
    assert.equal(storage.getItem("xt_orders_a"), "cached");
    assert.equal(storage.getItem("theme"), "neutral");
  });
});

check("新旧 key 同时存在时优先当前新会话，不用旧账号替换它", () => {
  const current = session("admin");
  const storage = new MemoryStorage({ [SESSION_KEY]: JSON.stringify(current), [LEGACY_KEY]: JSON.stringify(session("client", "older")) });
  withStorage(storage, () => {
    assert.deepEqual(getOptionalSession(), current);
    assert.deepEqual(storage.mutations, []);
  });
});

for (const role of ROLES) {
  check(`成功建立 ${role} 会话时，先清多账号缓存再写新会话`, () => {
    const incoming = session(role, "incoming");
    const storage = new MemoryStorage({ [SESSION_KEY]: JSON.stringify(session("client", "outgoing")), xt_orders_a: "cached-a", xt_orders_b: "cached-b", theme: "neutral" });
    withStorage(storage, () => {
      assert.equal(setAuthSession(incoming), incoming);
      assert.deepEqual(getOptionalSession(), incoming);
      assert.equal(storage.getItem("xt_orders_a"), null);
      assert.equal(storage.getItem("xt_orders_b"), null);
      assert.equal(storage.getItem("theme"), "neutral");
      const writeIndex = storage.mutations.findIndex(item => item.operation === "setItem" && item.key === SESSION_KEY);
      for (const cacheKey of ["xt_orders_a", "xt_orders_b"]) {
        const removeIndex = storage.mutations.findIndex(item => item.operation === "removeItem" && item.key === cacheKey);
        assert.ok(removeIndex >= 0 && writeIndex > removeIndex, "缓存应在写入新凭证之前清完");
      }
    });
  });
}

check("同一账号重新成功登录也清旧订单缓存，避免继续显示旧数据", () => {
  const current = session("client");
  const storage = new MemoryStorage({ [SESSION_KEY]: JSON.stringify(current), xt_orders_a: "cached-a" });
  withStorage(storage, () => {
    setAuthSession({ ...current, token: "client-state-fixture-refreshed" });
    assert.equal(storage.getItem("xt_orders_a"), null);
    assert.equal(getOptionalSession()?.token, "client-state-fixture-refreshed");
  });
});

check("明确退出同时清新旧会话 key；之后读取也不会复活旧账号", () => {
  const storage = new MemoryStorage({ [SESSION_KEY]: JSON.stringify(session("admin")), [LEGACY_KEY]: JSON.stringify(session("client", "older")), theme: "neutral" });
  withStorage(storage, () => {
    clearAuthSession(); clearAuthSession();
    assert.equal(getOptionalSession(), null);
    assert.deepEqual(storage.snapshot(), { theme: "neutral" });
  });
});

check("只有旧会话时明确退出同样有效，不依赖先触发迁移", () => {
  const storage = new MemoryStorage({ [LEGACY_KEY]: JSON.stringify(session("staff", "older")), theme: "neutral" });
  withStorage(storage, () => {
    clearAuthSession();
    assert.equal(getOptionalSession(), null);
    assert.deepEqual(storage.snapshot(), { theme: "neutral" });
  });
});

check("独立缓存清理覆盖相邻多用户 key，保留会话与无关 key", () => {
  const auth = JSON.stringify(session("client"));
  const storage = new MemoryStorage({ xt_orders_a: "a", xt_orders_b: "b", xt_orders_c: "c", [SESSION_KEY]: auth, theme: "neutral", xt_orders: "unrelated" });
  withStorage(storage, () => {
    clearClientOrderCaches();
    assert.deepEqual(storage.snapshot(), { [SESSION_KEY]: auth, theme: "neutral", xt_orders: "unrelated" });
  });
});

check("无 window 的服务端环境调用全部公共函数均不抛错", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Reflect.deleteProperty(globalThis, "window");
  try {
    const incoming = session("client");
    assert.equal(getOptionalSession(), null);
    assert.doesNotThrow(() => { prepareLoginPage(); clearAuthSession(); clearClientOrderCaches(); });
    assert.equal(setAuthSession(incoming), incoming);
  } finally { restoreWindow(previous); }
});

check("读取 localStorage 属性本身抛错时，全部公共函数仍可返回", () => {
  withWindow({ get localStorage(): Storage { throw new Error("Synthetic storage access denied"); } }, () => {
    const incoming = session("staff");
    assert.equal(getOptionalSession(), null);
    assert.doesNotThrow(() => { prepareLoginPage(); clearAuthSession(); clearClientOrderCaches(); });
    assert.equal(setAuthSession(incoming), incoming);
  });
});

for (const operation of ["getItem", "setItem", "removeItem", "key", "length"] as const) {
  check(`localStorage.${operation} 抛错时，入口/写会话/退出/清缓存都不崩溃`, () => {
    const storage = new MemoryStorage({ [SESSION_KEY]: JSON.stringify(session("client")), [LEGACY_KEY]: "{broken", xt_orders_a: "cached" }, operation);
    withStorage(storage, () => {
      assert.doesNotThrow(() => {
        getOptionalSession(); prepareLoginPage();
        const incoming = session("admin", "incoming");
        assert.equal(setAuthSession(incoming), incoming);
        clearAuthSession(); clearClientOrderCaches();
      });
    });
  });
}

if (failures.length > 0) {
  console.error(`登录入口与会话稳定性：${checks - failures.length}/${checks} 项通过，${failures.length} 项失败`);
  process.exitCode = 1;
} else {
  console.log(`登录入口与会话稳定性：${checks} 项全部通过`);
}
