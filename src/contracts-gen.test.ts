import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateContracts } from "./contracts-gen";

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function app(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "day2-contracts-"));
  roots.push(root);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), text);
  }
  return root;
}

describe("contracts from the app's own code", () => {
  test("React Router + Supabase: screens, tagged actions with what they do on success, untagged candidates", () => {
    const root = app({
      "package.json": '{"dependencies":{"react-router-dom":"6"}}',
      "src/main.tsx": `
        const router = createBrowserRouter([{ path: "/", element: <Shell />, children: [
          { path: "cart", element: <Cart /> },
          { path: "checkout", element: <Checkout /> },
          { path: "orders/:id", element: <Order /> },
        ]}]);`,
      "src/Cart.tsx": `
        export function Cart({ id }) {
          const navigate = useNavigate();
          const handleClear = useCallback(async () => {
            await supabase.from("cart_items").delete().eq("user", id);
          }, [id]);
          return (<div>
            <button data-day2-action="cart.continue" onClick={async () => {
              const r = await fetch("/api/cart/validate?x=1", { method: "POST" });
              if (r.ok) navigate("/checkout");
            }}>Continue</button>
            <button id="clear" onClick={handleClear}>Empty cart</button>
            <button onClick={() => navigate(\`/orders/\${id}\`)}>View order</button>
            <button onClick={() => setOpen(true)}>Details</button>
          </div>);
        }`,
      "src/Checkout.tsx": `export const Checkout = () => <main><p data-day2-require="total">Total</p><form onSubmit={submit}><button>Pay</button></form></main>;
        async function submit(e) { e.preventDefault(); await supabase.rpc("place_order"); navigate({ to: "/receipt" }); }`,
      "src/Cart.test.tsx": `<button data-day2-action="ignored" onClick={() => navigate("/x")}>x</button>`,
    });
    const g = generateContracts(root, new Date("2026-10-15T00:00:00Z"));
    expect(g.file.contracts.filter((c) => c.kind === "screen").map((c) => (c as { route: string }).route)).toEqual(["/", "/cart", "/checkout", "/orders/:id"]);
    const actions = Object.fromEntries(g.file.contracts.filter((c) => c.kind === "action").map((c) => [c.id, c]));
    expect(actions["cart.continue"]).toMatchObject({ target: "action:cart.continue", expect: [{ request: "POST /api/cart/validate" }, { screen: "/checkout" }], origin: "src/Cart.tsx:8" });
    expect(actions["cart.clear"]).toMatchObject({ target: "#clear", expect: [{ request: "DELETE /rest/v1/cart_items" }] });
    expect(Object.keys(actions)).not.toContain("ignored");
    // Untagged, so not findable on the device yet: a candidate for the install ticket.
    expect(g.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "cart.view_order", expect: [{ screen: "/orders/:id" }], label: "View order" }),
        expect.objectContaining({ name: "checkout.pay", expect: [{ request: "POST /rest/v1/rpc/place_order" }, { screen: "/receipt" }] }),
      ]),
    );
    // A handler that only changes local state has no contract to check.
    expect(g.candidates.some((c) => c.label === "Details")).toBe(false);
  });

  test("TanStack Router, Next.js and Expo Router routes", () => {
    const tan = app({
      "package.json": "{}",
      "src/routes/apps.$appId.backlog.tsx": `export const Route = createFileRoute('/apps/$appId/backlog')({ component: B })`,
      "src/routes/index.tsx": `export const Route = createFileRoute('/')({ component: Home })`,
    });
    expect(generateContracts(tan).file.contracts.map((c) => (c as { route: string }).route).sort()).toEqual(["/", "/apps/:appId/backlog"]);

    const next = app({
      "package.json": '{"dependencies":{"next":"15"}}',
      "app/page.tsx": "export default function P() {}",
      "app/(shop)/products/[slug]/page.tsx": "export default function P() {}",
      "app/layout.tsx": "export default function L() {}",
      "pages/api/hello.ts": "export default () => {}",
      "pages/about.tsx": "export default () => {}",
    });
    expect(generateContracts(next).file.contracts.map((c) => (c as { route: string }).route).sort()).toEqual(["/", "/about", "/products/:slug"]);

    const expo = app({
      "package.json": '{"dependencies":{"expo-router":"4"}}',
      "app/(tabs)/index.tsx": "export default () => null",
      "app/(tabs)/settings.tsx": "export default () => null",
      "app/_layout.tsx": "export default () => null",
      "app/order/[id].tsx": `export default () => <Pressable testID="pay" onPress={() => navigation.navigate("Receipt")}><Text>Pay</Text></Pressable>`,
    });
    const g = generateContracts(expo);
    expect(g.file.contracts.filter((c) => c.kind === "screen").map((c) => (c as { route: string }).route).sort()).toEqual(["/", "/order/:id", "/settings"]);
    expect(g.file.contracts.find((c) => c.kind === "action")).toMatchObject({ target: '[data-testid="pay"]', expect: [{ screen: "Receipt" }] });
  });

  test("computed targets are left out, not guessed", () => {
    const root = app({
      "package.json": "{}",
      "src/A.tsx": `export const A = ({ to }) => <button id="go" onClick={() => navigate(to)}>Go</button>;`,
    });
    const g = generateContracts(root);
    expect(g.file.contracts.filter((c) => c.kind === "action")).toEqual([]);
    expect(g.candidates).toEqual([]);
  });
});
