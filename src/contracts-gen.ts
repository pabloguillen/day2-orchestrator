import ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { indexRepo, type RepoIndex } from "./distribution-loops";
import { CONTRACTS_VERSION, type ActionContract, type Contract, type ContractFile, type Expectation, type ScreenContract } from "../packages/sensors/src/types";

/**
 * Writes an app's field contracts from its own code — no guessing, no
 * owner work. Read with the TypeScript parser (TS, TSX, JS, JSX):
 *
 *  - Screens: every route the app declares (TanStack Router, React Router,
 *    Next.js pages/app, Expo Router). Elements marked
 *    `data-day2-require` in a screen's file must appear when it renders.
 *  - Actions: every tap or submit handler whose code navigates
 *    (`navigate('/checkout')`, `router.push`, `navigation.navigate('Receipt')`)
 *    or calls the backend (`fetch(…, { method: 'POST' })`, axios, Supabase
 *    `.from('orders').insert()`, `.rpc()`) — what it does on success is
 *    the contract. The element must be findable on the device: tagged
 *    `data-day2-action`, or with a literal `id` / `data-testid`.
 *    Untagged ones come back as candidates — the install ticket tags them.
 *
 * Only literal targets become contracts; a computed one (a path from a
 * variable) is left out rather than guessed.
 */

export const CONTRACTS_FILENAME = "day2.contracts.json";

export type Candidate = {
  /** Suggested `data-day2-action` value. */
  name: string;
  origin: string;
  expect: Expectation[];
  label: string;
};

export type Generated = { file: ContractFile; candidates: Candidate[]; screens: number; actions: number };

const SOURCE = /\.(tsx?|jsx?|mjs)$/;
const SKIP = /(\.test\.|\.spec\.|__tests__|\/e2e\/|\.d\.ts$|\.stories\.)/;

const kindOf = (f: string) => (f.endsWith(".tsx") ? ts.ScriptKind.TSX : f.endsWith(".jsx") ? ts.ScriptKind.JSX : f.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "action";

/** A string literal or a template whose holes become ":id". */
function literal(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let s = node.head.text;
    for (const span of node.templateSpans) s += `:id${span.literal.text}`;
    return s;
  }
  return null;
}

/** "$appId" (TanStack) / "[id]" (Next, Expo) → ":appId" / ":id". */
function toPattern(path: string): string {
  const out = path
    .split("/")
    .filter((seg) => !/^\(.*\)$/.test(seg) && !seg.startsWith("_"))
    .map((seg) => (seg.startsWith("$") && seg.length > 1 ? `:${seg.slice(1)}` : seg.replace(/^\[\.\.\.(.+)\]$/, "*").replace(/^\[(.+)\]$/, ":$1")))
    .join("/");
  const clean = `/${out}`.replace(/\/+/g, "/").replace(/\/index$/, "").replace(/(.)\/$/, "$1");
  return clean || "/";
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function routesFromFiles(repo: RepoIndex, expoRouter: boolean): Array<{ route: string; file: string }> {
  const out: Array<{ route: string; file: string }> = [];
  for (const f of repo.files) {
    if (!SOURCE.test(f) || SKIP.test(f)) continue;
    // Next.js pages router.
    const pages = f.match(/^(?:src\/)?pages\/(.+)\.(tsx|jsx|ts|js)$/);
    if (pages && !pages[1]!.startsWith("api/") && !/^_(app|document|error)$/.test(pages[1]!)) {
      out.push({ route: toPattern(pages[1]!), file: f });
      continue;
    }
    // Next.js app router (page files) and Expo Router (every non-layout file).
    const app = f.match(/^(?:src\/)?app\/(.*?)(?:\/)?(page|[^/]+)\.(tsx|jsx|ts|js)$/);
    if (app) {
      const [, dir, name] = app;
      if (name === "page") out.push({ route: toPattern(dir!), file: f });
      else if (expoRouter && !name!.startsWith("_") && !name!.startsWith("+")) out.push({ route: toPattern(`${dir ? `${dir}/` : ""}${name}`), file: f });
    }
  }
  return out;
}

function routesFromCode(sf: ts.SourceFile, file: string): Array<{ route: string; file: string }> {
  const out: Array<{ route: string; file: string }> = [];
  const visit = (node: ts.Node, parentPath: string) => {
    let base = parentPath;
    // TanStack Router: createFileRoute('/apps/$appId/backlog')
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === "createFileRoute" || node.expression.text === "createRoute")) {
      const p = literal(node.arguments[0]);
      if (p && p.startsWith("/")) out.push({ route: toPattern(p), file });
    }
    // React Router JSX: <Route path="checkout" element={…}>
    if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && tagName(node) === "Route") {
      const p = attrString(node, "path");
      if (p !== null) {
        base = p.startsWith("/") ? p : `${parentPath}/${p}`;
        out.push({ route: toPattern(base), file });
      }
    }
    // React Router objects: { path: "checkout", children: [...] } inside createBrowserRouter / useRoutes.
    if (ts.isObjectLiteralExpression(node) && insideRouterCall(node)) {
      const prop = node.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === "path");
      const p = literal(prop?.initializer);
      if (p !== null) {
        base = p.startsWith("/") ? p : `${parentPath}/${p}`;
        out.push({ route: toPattern(base), file });
      }
    }
    ts.forEachChild(node, (c) => visit(c, base));
  };
  visit(sf, "");
  return out;
}

function insideRouterCall(node: ts.Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && /^(createBrowserRouter|createHashRouter|createMemoryRouter|useRoutes)$/.test(p.expression.text)) return true;
  }
  return false;
}

function tagName(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
  const t = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
  return t.getText();
}

function attrs(node: ts.JsxElement | ts.JsxSelfClosingElement): ts.JsxAttributes {
  return ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
}

function attr(node: ts.JsxElement | ts.JsxSelfClosingElement, name: string): ts.JsxAttribute | undefined {
  return attrs(node).properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
}

function attrString(node: ts.JsxElement | ts.JsxSelfClosingElement, name: string): string | null {
  const a = attr(node, name);
  if (!a?.initializer) return null;
  if (ts.isStringLiteral(a.initializer)) return a.initializer.text;
  if (ts.isJsxExpression(a.initializer)) return literal(a.initializer.expression);
  return null;
}

// ---------------------------------------------------------------------------
// What a handler does on success
// ---------------------------------------------------------------------------

const SUPABASE_METHOD: Record<string, string> = { insert: "POST", upsert: "POST", update: "PATCH", delete: "DELETE" };

/** Navigations and backend calls in a handler's code, in order. */
function effects(body: ts.Node, sf: ts.SourceFile): Expectation[] {
  const out: Expectation[] = [];
  const seen = new Set<string>();
  const add = (e: Expectation) => {
    const k = JSON.stringify(e);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(e);
    }
  };
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      const obj = ts.isPropertyAccessExpression(callee) ? callee.expression.getText(sf) : "";
      const first = n.arguments[0];
      // navigate('/x'), navigate({ to: '/x' }), router.push('/x'), history.push('/x')
      if (name === "navigate" || ((name === "push" || name === "replace") && /router|history/i.test(obj))) {
        let to = literal(first);
        if (!to && first && ts.isObjectLiteralExpression(first)) {
          const p = first.properties.find((x): x is ts.PropertyAssignment => ts.isPropertyAssignment(x) && /^(to|pathname)$/.test(x.name.getText(sf)));
          to = literal(p?.initializer);
        }
        if (to) add({ screen: to.startsWith("/") ? toPattern(to) : to });
      }
      // fetch('/api/x', { method: 'POST' })
      if (name === "fetch" && !obj) {
        const url = literal(first);
        let method = "GET";
        const init = n.arguments[1];
        if (init && ts.isObjectLiteralExpression(init)) {
          const m = init.properties.find((x): x is ts.PropertyAssignment => ts.isPropertyAssignment(x) && x.name.getText(sf) === "method");
          method = (literal(m?.initializer) ?? "GET").toUpperCase();
        }
        if (url && url.startsWith("/") && method !== "GET") add({ request: `${method} ${toRequestPath(url)}` });
      }
      // axios.post('/api/x') / api.post('/x')
      if (/^(post|put|patch|delete)$/.test(name) && obj && !/supabase|\.from\(/.test(obj)) {
        const url = literal(first);
        if (url && url.startsWith("/")) add({ request: `${name.toUpperCase()} ${toRequestPath(url)}` });
      }
      // supabase.from('orders').insert(...)
      if (SUPABASE_METHOD[name] && ts.isPropertyAccessExpression(callee) && ts.isCallExpression(callee.expression)) {
        const inner = callee.expression;
        if (ts.isPropertyAccessExpression(inner.expression) && inner.expression.name.text === "from") {
          const table = literal(inner.arguments[0]);
          if (table) add({ request: `${SUPABASE_METHOD[name]} /rest/v1/${table}` });
        }
      }
      // supabase.rpc('fn')
      if (name === "rpc" && /supabase/i.test(obj)) {
        const fn = literal(first);
        if (fn) add({ request: `POST /rest/v1/rpc/${fn}` });
      }
      // React Native: navigation.navigate('Receipt')
      if (name === "navigate" && /navigation/i.test(obj)) {
        const screen = literal(first);
        if (screen && !screen.startsWith("/")) add({ screen });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  // Requests first, then where the user lands: the order things happen.
  return [...out.filter((e) => "request" in e), ...out.filter((e) => "screen" in e).slice(-1)];
}

const toRequestPath = (url: string) => url.split(/[?#]/)[0]!.replace(/\/+$/, "") || "/";

/** The code a JSX handler attribute runs: an inline function, or a function declared in the same file. */
function handlerBody(init: ts.JsxAttribute["initializer"], sf: ts.SourceFile): ts.Node | null {
  if (!init || !ts.isJsxExpression(init) || !init.expression) return null;
  const e = init.expression;
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e.body;
  let name = "";
  if (ts.isIdentifier(e)) name = e.text;
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) name = e.expression.text; // handleSubmit(onSubmit)
  if (ts.isCallExpression(e) && e.arguments[0] && ts.isIdentifier(e.arguments[0])) name = e.arguments[0].text;
  if (!name) return null;
  let found: ts.Node | null = null;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) found = n.body;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      let init2: ts.Expression = n.initializer;
      // useCallback(async () => {...}, [])
      if (ts.isCallExpression(init2) && init2.arguments[0]) init2 = init2.arguments[0];
      if (ts.isArrowFunction(init2) || ts.isFunctionExpression(init2)) found = init2.body;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

function jsxText(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
  if (!ts.isJsxElement(node)) return attrString(node, "aria-label") ?? "";
  const parts: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) parts.push(n.text.trim());
    ts.forEachChild(n, visit);
  };
  node.children.forEach(visit);
  return attrString(node, "aria-label") ?? parts.filter(Boolean).join(" ").slice(0, 40);
}

// ---------------------------------------------------------------------------
// The whole app
// ---------------------------------------------------------------------------

export function generateContracts(repoPath: string, now = new Date()): Generated {
  const repo = indexRepo(repoPath);
  const pkg = existsSync(join(repoPath, "package.json")) ? readFileSync(join(repoPath, "package.json"), "utf-8") : "";
  const expoRouter = /"expo-router"/.test(pkg);
  const routes = new Map<string, { route: string; file: string }>();
  for (const r of routesFromFiles(repo, expoRouter)) routes.set(r.route, r);

  const actions: ActionContract[] = [];
  const candidates: Candidate[] = [];
  const requireByFile = new Map<string, string[]>();
  const usedIds = new Set<string>();

  for (const f of repo.files) {
    if (!SOURCE.test(f) || SKIP.test(f)) continue;
    const text = repo.read(f);
    if (!text) continue;
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, kindOf(f));
    for (const r of routesFromCode(sf, f)) if (!routes.has(r.route)) routes.set(r.route, r);
    // "apps.$appId.backlog.$ticketId.tsx" → "backlog"; "Cart.tsx" → "cart".
    const component =
      f
        .split("/")
        .pop()!
        .replace(/\.(tsx?|jsx?|mjs)$/, "")
        .split(".")
        .filter((s) => s && !s.startsWith("$") && !/^\[.*\]$/.test(s) && s !== "index" && s !== "route")
        .slice(-2)
        .join("_") || "app";

    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const req = attrString(node, "data-day2-require");
        if (req) requireByFile.set(f, [...(requireByFile.get(f) ?? []), `[data-day2-require="${req}"]`]);
        const handler = attr(node, "onClick") ?? attr(node, "onPress") ?? attr(node, "onSubmit");
        const body = handler ? handlerBody(handler.initializer, sf) : null;
        if (body) {
          const expect = effects(body, sf);
          if (expect.length) {
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            const origin = `${f}:${line}`;
            const tagged = attrString(node, "data-day2-action");
            const id = attrString(node, "id");
            const testId = attrString(node, "data-testid") ?? attrString(node, "testID");
            const label = jsxText(node);
            const target = tagged ? `action:${tagged}` : id ? `#${id}` : testId ? `[data-testid="${testId}"]` : null;
            if (target) {
              let cid = tagged ?? `${slug(component)}.${slug(id ?? testId ?? label)}`;
              while (usedIds.has(cid)) cid = `${cid}_${line}`;
              usedIds.add(cid);
              actions.push({ id: cid, kind: "action", target, expect, source: "code", origin });
            } else {
              candidates.push({ name: `${slug(component)}.${slug(label || tagName(node)).slice(0, 24).replace(/_+$/, "")}`, origin, expect, label: label || tagName(node) });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  const screens: ScreenContract[] = [...routes.values()]
    .sort((a, b) => a.route.localeCompare(b.route))
    .map((r) => ({
      id: `screen:${r.route}`,
      kind: "screen",
      route: r.route,
      ...(requireByFile.get(r.file)?.length ? { require: requireByFile.get(r.file) } : {}),
      source: "code",
      origin: r.file,
    }));

  const contracts: Contract[] = [...screens, ...actions];
  return { file: { version: CONTRACTS_VERSION, generatedAt: now.toISOString(), contracts }, candidates, screens: screens.length, actions: actions.length };
}
