/** Run actual core-api/auth-session modules in an isolated VM; no real network or credentials. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';

const root = process.cwd();
const cases: { name: string; passed: boolean; error?: string }[] = [];
const now = Math.floor(Date.now() / 1000);
const token = (id: string, exp = now + 3600) => `e30.${Buffer.from(JSON.stringify({ exp, fixture: id })).toString('base64url')}.fixture`;
const A = token('A'), B = token('B'), OLD = token('OLD', now - 60);
const session = (token: string) => ({ userId: 'fixture-user', companyId: 'fixture-company', role: 'client', token });
function setup(initial: string | null = A) {
  const stored = new Map<string, string>();
  const redirects: string[] = [], warnings: unknown[] = [], requests: { input: unknown; init: RequestInit | undefined }[] = [];
  if (initial !== null) stored.set('auth_session_v1', JSON.stringify(session(initial)));
  stored.set('xt_orders_fixture-user', 'private fixture cache'); stored.set('unrelated', 'preserve');
  const localStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, val: string) => { stored.set(key, String(val)); },
    removeItem: (key: string) => { stored.delete(key); },
    key: (index: number) => [...stored.keys()][index] ?? null,
    get length() { return stored.size; },
  };
  let fetchHandler: (input: unknown, init?: RequestInit) => Promise<Response> = async () => response(200);
  const location = { pathname: '/client', get href() { return redirects.at(-1) ?? ''; }, set href(value: string) { redirects.push(value); } };
  const context = vm.createContext({ window: { localStorage, location }, console: { warn: (...args: unknown[]) => warnings.push(args), error: () => {} }, Response, Request, Headers, AbortController, atob, setTimeout, clearTimeout, process: { env: {} }, fetch: async function(input: unknown, init?: RequestInit) { requests.push({ input, init }); return fetchHandler(input, init); } });
  const cache = new Map<string, Record<string, any>>();
  function load(relative: string): Record<string, any> {
    const filename = path.resolve(root, relative);
    if (cache.has(filename)) return cache.get(filename)!;
    const source = fs.readFileSync(filename, 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = { exports: {} as Record<string, any> }; cache.set(filename, module.exports);
    const factory = vm.runInContext(`(function(require,module,exports){${code}\n})`, context, { filename });
    factory((specifier: string) => load(path.relative(root, path.resolve(path.dirname(filename), specifier + '.ts'))), module, module.exports);
    return module.exports;
  }
  const api = load('apps/web/src/services/core-api.ts');
  return { api, stored, requests, redirects, warnings, location, replace: (t: string | null) => { if (t === null) stored.delete('auth_session_v1'); else stored.set('auth_session_v1', JSON.stringify(session(t))); }, fetch: (fn: typeof fetchHandler) => { fetchHandler = fn; }, current: () => { const raw = stored.get('auth_session_v1'); return raw ? JSON.parse(raw).token : null; } };
}
function response(status: number, url = 'http://fixture.test/client/orders', data: unknown = { value: 1 }) { const r = new Response(JSON.stringify(status < 400 ? { code: 'OK', data } : { code: 'ERROR', message: 'fixture failure' }), { status, headers: { 'Content-Type': 'application/json' } }); Object.defineProperty(r, 'url', { value: url }); return r; }
async function rejected(fn: () => Promise<unknown>, pattern?: RegExp) { let thrown: any; try { await fn(); } catch (e) { thrown = e; } assert.ok(thrown, 'expected rejection'); if (pattern) assert.match(thrown.message, pattern); }
async function check(name: string, fn: () => Promise<void> | void) { try { await fn(); cases.push({name,passed:true}); console.log(`PASS ${name}`); } catch(e) { cases.push({name,passed:false,error:String(e)}); console.log(`FAIL ${name}: ${String(e)}`); } }
async function run() {
await check('expired 401 clears only current auth and client caches', async()=>{const s=setup(OLD);await rejected(()=>s.api.parseApiResponse(response(401),OLD));assert.equal(s.current(),null);assert.equal(s.stored.has('xt_orders_fixture-user'),false);assert.equal(s.stored.get('unrelated'),'preserve');assert.deepEqual(s.redirects,['/login?expired=1']);});
await check('malformed current token 401 clears invalid session',async()=>{const s=setup('malformed');await rejected(()=>s.api.parseApiResponse(response(401),'malformed'));assert.equal(s.current(),null);assert.equal(s.redirects.length,1);});
await check('anonymous 401 cleans residual client data and redirects',async()=>{const s=setup(null);await rejected(()=>s.api.parseApiResponse(response(401),null));assert.equal(s.stored.has('xt_orders_fixture-user'),false);assert.equal(s.redirects.length,1);});
await check('single future token 401 preserves session, draft cache and URL',async()=>{const s=setup();await rejected(()=>s.api.parseApiResponse(response(401),A));assert.equal(s.current(),A);assert.equal(s.stored.has('xt_orders_fixture-user'),true);assert.equal(s.redirects.length,0);});
await check('third consecutive same-token 401 explicitly signs out',async()=>{const s=setup();for(let i=0;i<3;i++)await rejected(()=>s.api.parseApiResponse(response(401),A));assert.equal(s.current(),null);assert.equal(s.stored.has('xt_orders_fixture-user'),false);assert.equal(s.redirects.length,1);});
await check('401 counters do not carry between tokens',async()=>{const s=setup();for(let i=0;i<2;i++)await rejected(()=>s.api.parseApiResponse(response(401),A));s.replace(B);await rejected(()=>s.api.parseApiResponse(response(401),B));assert.equal(s.current(),B);assert.equal(s.redirects.length,0);for(let i=0;i<2;i++)await rejected(()=>s.api.parseApiResponse(response(401),B));assert.equal(s.current(),null);});
await check('late expired-token 401 never deletes newer login',async()=>{const s=setup(B);for(let i=0;i<4;i++)await rejected(()=>s.api.parseApiResponse(response(401),OLD));assert.equal(s.current(),B);assert.equal(s.redirects.length,0);assert.equal(s.stored.has('xt_orders_fixture-user'),true);});
await check('late anonymous 401 never deletes newer login',async()=>{const s=setup(B);for(let i=0;i<4;i++)await rejected(()=>s.api.parseApiResponse(response(401),null));assert.equal(s.current(),B);assert.equal(s.redirects.length,0);});
await check('unknown response origin does not clear a current session',async()=>{const s=setup(OLD);await rejected(()=>s.api.parseApiResponse(response(401)));assert.equal(s.current(),OLD);assert.equal(s.redirects.length,0);});
await check('stale success does not reset newer-token 401 counter',async()=>{const s=setup(B);for(let i=0;i<2;i++)await rejected(()=>s.api.parseApiResponse(response(401),B));await s.api.parseApiResponse(response(200),A);await rejected(()=>s.api.parseApiResponse(response(401),B));assert.equal(s.current(),null);});
await check('current success resets same-token 401 counter',async()=>{const s=setup(A);for(let i=0;i<2;i++)await rejected(()=>s.api.parseApiResponse(response(401),A));await s.api.parseApiResponse(response(200),A);await rejected(()=>s.api.parseApiResponse(response(401),A));assert.equal(s.current(),A);assert.equal(s.redirects.length,0);});
await check('login 401 never destroys current identity or cache',async()=>{const s=setup(OLD);for(let i=0;i<4;i++)await rejected(()=>s.api.parseApiResponse(response(401,'http://fixture.test/auth/login'),OLD),/账号或密码/);assert.equal(s.current(),OLD);assert.equal(s.stored.has('xt_orders_fixture-user'),true);assert.equal(s.redirects.length,0);});
for(const status of [403,500]) await check(`${status} preserves current session and cache`,async()=>{const s=setup(OLD);await rejected(()=>s.api.parseApiResponse(response(status),OLD));assert.equal(s.current(),OLD);assert.equal(s.stored.has('xt_orders_fixture-user'),true);assert.equal(s.redirects.length,0);});
await check('parsed success response and data shape unchanged',async()=>{const s=setup();assert.equal((await s.api.parseApiResponse(response(200),A)).value,1);assert.equal(s.current(),A);});
await check('fetch wrapper preserves exact RequestInit/input and real response',async()=>{const s=setup();const body='{"fixture":true}',signal=new AbortController().signal,init={method:'PATCH',headers:{Authorization:`Bearer ${A}`,'X-Fixture':'one'},body,signal,credentials:'include' as const};const r=response(200);s.fetch(async()=>r);const actual=await s.api.fetchWithSession('/fixture',init);assert.equal(s.requests[0].input,'/fixture');assert.equal(s.requests[0].init,init);assert.equal(actual,r);await s.api.parseApiResponse(actual);assert.equal(s.current(),A);});
await check('direct fetch then parse binds expired identity',async()=>{const s=setup(OLD);s.fetch(async()=>response(401));await rejected(()=>s.api.fetchWithSession('/fixture',{headers:{Authorization:`Bearer ${OLD}`}}).then(s.api.parseApiResponse));assert.equal(s.current(),null);});
await check('wrapper capture is fixed before asynchronous response',async()=>{const s=setup(OLD);let resolve!: (r:Response)=>void;s.fetch(()=>new Promise(r=>{resolve=r}));const init={headers:{Authorization:`Bearer ${OLD}`}};const pending=s.api.fetchWithSession('/fixture',init);s.replace(B);init.headers.Authorization=`Bearer ${B}`;resolve(response(401));await rejected(async()=>s.api.parseApiResponse(await pending));assert.equal(s.current(),B);assert.equal(s.redirects.length,0);});
await check('wrapper supports Request headers and lowercase Headers',async()=>{const s=setup(OLD);s.fetch(async()=>response(401));const req=new Request('http://fixture.test/client/orders',{headers:new Headers({authorization:`Bearer ${OLD}`})});await rejected(async()=>s.api.parseApiResponse(await s.api.fetchWithSession(req)));assert.equal(s.current(),null);});
await check('wrapper captures explicitly unauthenticated request',async()=>{const s=setup(null);let resolve!: (r:Response)=>void;s.fetch(()=>new Promise(r=>{resolve=r}));const pending=s.api.fetchWithSession('/fixture');s.replace(B);resolve(response(401));await rejected(async()=>s.api.parseApiResponse(await pending));assert.equal(s.current(),B);assert.equal(s.redirects.length,0);});
await check('apiRequest terminal 401 uses sent token snapshot',async()=>{const s=setup(OLD);s.fetch(async()=>response(401));await rejected(()=>s.api.apiRequest('/fixture',{method:'GET'}));assert.equal(s.current(),null);assert.equal(s.redirects.length,1);});
await check('apiRequest late old 401 preserves new token',async()=>{const s=setup(OLD);s.fetch(async()=>{s.replace(B);return response(401)});for(let i=0;i<1;i++)await rejected(()=>s.api.apiRequest('/fixture'));assert.equal(s.current(),B);assert.equal(s.redirects.length,0);});
await check('apiRequest respects explicit authorization override when classifying 401',async()=>{const s=setup(B);s.fetch(async()=>response(401));for(let i=0;i<4;i++)await rejected(()=>s.api.apiRequest('/fixture',{headers:{Authorization:`Bearer ${OLD}`}}));assert.equal(s.current(),B);assert.equal(s.redirects.length,0);});
await check('apiRequest 500 remains single attempt with no signout',async()=>{const s=setup(OLD);s.fetch(async()=>response(500));await rejected(()=>s.api.apiRequest('/fixture'),/服务器繁忙/);assert.equal(s.requests.length,1);assert.equal(s.current(),OLD);assert.equal(s.redirects.length,0);});
await check('terminal 401 does not navigate again while on login page',async()=>{const s=setup(OLD);s.location.pathname='/login';await rejected(()=>s.api.parseApiResponse(response(401),OLD));assert.equal(s.current(),null);assert.equal(s.redirects.length,0);});
await check('diagnostics never contain fixture token values',async()=>{const s=setup(OLD);await rejected(()=>s.api.parseApiResponse(response(401),OLD));const text=JSON.stringify(s.warnings);assert.equal(text.includes(OLD),false);assert.equal(text.includes(A),false);});
/**
 * 源码扫描（2026-09-05 复查补）：parseApiResponse 靠 fetchWithSession 记住「这次请求带的是哪枚令牌」，
 * 裸 fetch 的响应它认不出归属，401 时只报错、永远不跳登录页。所以：凡是调 parseApiResponse 的文件，
 * 只要自己写了 fetch( 就必须 import { fetchWithSession as fetch }。这条以后一漏就红。
 */
await check('every file calling parseApiResponse aliases fetchWithSession as fetch (no bare fetch)',()=>{
  /**
   * 2026-09-06 Codex 复核 P2-2 后改成走 TypeScript AST：正则版会被注释骗、漏 globalThis.fetch、漏嵌套泛型。
   * 规则：文件里只要有一次 parseApiResponse(resp) 没显式传第二个参数 sentToken，
   *      就不许出现任何「裸」fetch 调用 —— 未起别名的 fetch(...)、globalThis/window/self.fetch(...)。
   *      import { fetchWithSession as fetch } 之后的 fetch(...) 才算合规。注释、字符串一概不看。
   */
  type Scan={parseCallsWithoutToken:number;parseCalls:number;bareFetchCalls:number;aliased:boolean};
  const scan=(source:string,fileName:string):Scan=>{
    const sf=ts.createSourceFile(fileName,source,ts.ScriptTarget.Latest,true,fileName.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
    const r:Scan={parseCallsWithoutToken:0,parseCalls:0,bareFetchCalls:0,aliased:false};
    const visit=(node:ts.Node)=>{
      if(ts.isImportDeclaration(node)&&node.importClause?.namedBindings&&ts.isNamedImports(node.importClause.namedBindings)){
        for(const el of node.importClause.namedBindings.elements){if(el.propertyName?.text==='fetchWithSession'&&el.name.text==='fetch')r.aliased=true;}
      }
      if(ts.isCallExpression(node)){
        const callee=node.expression;
        if(ts.isIdentifier(callee)&&callee.text==='parseApiResponse'){r.parseCalls++;if(node.arguments.length<2)r.parseCallsWithoutToken++;}
      }
      // 「裸 fetch」按**引用**算，不只按调用算（Codex 第二轮：`const f = fetch; f(...)` 也得抓）：
      //  ① 没起别名时，任何位置出现的标识符 fetch（import 说明符本身、`x.fetch` 里的属性名、对象字面量的键除外）
      //  ② globalThis / window / self 上的 .fetch 或 ['fetch']，不管有没有别名
      const isGlobalHost=(e:ts.Expression)=>ts.isIdentifier(e)&&['globalThis','window','self'].includes(e.text);
      if(ts.isIdentifier(node)&&node.text==='fetch'&&!r.aliased){
        const p=node.parent;
        const isPropName=(ts.isPropertyAccessExpression(p)&&p.name===node)||(ts.isPropertyAssignment(p)&&p.name===node)||ts.isImportSpecifier(p)||ts.isExportSpecifier(p);
        if(!isPropName)r.bareFetchCalls++;
      }
      if(ts.isPropertyAccessExpression(node)&&node.name.text==='fetch'&&isGlobalHost(node.expression))r.bareFetchCalls++;
      if(ts.isElementAccessExpression(node)&&isGlobalHost(node.expression)&&ts.isStringLiteralLike(node.argumentExpression)&&node.argumentExpression.text==='fetch')r.bareFetchCalls++;
      ts.forEachChild(node,visit);
    };
    visit(sf);
    return r;
  };
  // 别名声明在文件顶部，先扫 import 再数调用：AST 遍历按源码顺序，import 一定先于函数体
  const offender=(s:Scan)=>s.parseCallsWithoutToken>0&&s.bareFetchCalls>0;
  const webSrc=path.join(root,'apps/web/src');
  const files:string[]=[];
  const walk=(dir:string)=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.tsx?$/.test(entry.name))files.push(full);}};
  walk(webSrc);
  const scanned=files.map(f=>({file:f,scan:scan(fs.readFileSync(f,'utf8'),f)}));
  const callers=scanned.filter(s=>s.scan.parseCalls>0);
  assert.ok(callers.length>=4,`只扫到 ${callers.length} 个调用 parseApiResponse 的文件，扫描本身可能失效`);
  assert.ok(callers.some(s=>s.file.endsWith('ContainerTrackingSection.tsx')),'带泛型的调用没扫到，AST 遍历退化了');
  const bad=callers.filter(s=>offender(s.scan)&&!s.file.endsWith('core-api.ts'));
  assert.deepEqual(bad.map(s=>path.relative(root,s.file)),[],'这些文件裸用 fetch 又调 parseApiResponse（没传 sentToken），401 永远不会跳登录页');
  // 变异自证：五种人造源码，扫描必须给出正确判断（Codex 2026-09-06 列的漏报/误报清单）
  const alias="import { fetchWithSession as fetch, parseApiResponse } from './core-api';\n";
  const cases:[string,string,boolean][]=[
    ['合规：别名 + 嵌套泛型',alias+"export async function a(){ return parseApiResponse<Array<string>>(await fetch('/x')); }",false],
    ['违规：没别名的裸 fetch + 简单泛型',"import { parseApiResponse } from './core-api';\nexport async function a(){ return parseApiResponse<string>(await fetch('/x')); }",true],
    ['违规：别名了但用 globalThis.fetch',alias+"export async function a(){ return parseApiResponse<string>(await globalThis.fetch('/x')); }",true],
    ['违规：window.fetch',alias+"export async function a(){ return parseApiResponse(await window.fetch('/x')); }",true],
    ['违规：只有注释里写了别名，实际没 import',"// import { fetchWithSession as fetch }\nimport { parseApiResponse } from './core-api';\nexport async function a(){ return parseApiResponse(await fetch('/x')); }",true],
    ['合规：注释里有 fetch (，代码里没有裸 fetch，parse 显式传了 sentToken',"import { parseApiResponse } from './core-api';\n// fetch (x) 只是注释\nexport async function a(r:Response,t:string){ return parseApiResponse(r,t); }",false],
    ['合规：裸 fetch 但每次 parse 都显式传 sentToken',"import { parseApiResponse } from './core-api';\nexport async function a(t:string){ return parseApiResponse(await fetch('/x'),t); }",false],
    // Codex 2026-09-06 第二轮补的两种漏网写法
    ['违规：先起个本地别名再调 const f = fetch; f(...)',"import { parseApiResponse } from './core-api';\nconst f = fetch;\nexport async function a(){ return parseApiResponse(await f('/x')); }",true],
    ["违规：方括号取 window['fetch']",alias+"export async function a(){ return parseApiResponse(await window['fetch']('/x')); }",true],
    ['违规：globalThis["fetch"] 存进变量再用',alias+'const g = globalThis["fetch"];\nexport async function a(){ return parseApiResponse(await g("/x")); }',true],
    ['合规：别名之后 const f = fetch 指向的就是 fetchWithSession',alias+"const f = fetch;\nexport async function a(){ return parseApiResponse(await f('/x')); }",false],
    ['合规：对象字面量里叫 fetch 的键不算引用',"import { parseApiResponse } from './core-api';\nconst api = { fetch: 1 };\nexport async function a(r:Response){ return parseApiResponse(r, 't'); }",false],
  ];
  for(const [name,src,expected] of cases)assert.equal(offender(scan(src,'case.ts')),expected,`扫描判断错了：${name}`);
});
const report={passed:cases.filter(c=>c.passed).length,failed:cases.filter(c=>!c.passed).length,cases};
if(process.env.SESSION_API_REPORT)fs.writeFileSync(process.env.SESSION_API_REPORT,JSON.stringify(report,null,2));
console.log(`Session API: ${report.passed} passed, ${report.failed} failed`);if(report.failed)process.exitCode=1;
}
void run();
