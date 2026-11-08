import { toHex } from "./brand-kit";
import type { FigmaTokens } from "./brand-kit";

/**
 * Optional design source: a Figma file's published styles (colours and text
 * styles) as brand-kit tokens, when the owner connects one on Growth →
 * Formats with the file's URL and a personal access token (read-only scope
 * `file_content:read`). The app's repo stays the default source.
 *
 * Why the REST API and not Figma's MCP server: day2's connectors framework
 * (src/connectors.ts) runs remote MCP servers inside agent runs, with OAuth
 * per connector. Figma's official MCP server is the Dev Mode server (local,
 * in the desktop app) or the remote one that needs a Figma seat with Dev
 * Mode and an interactive OAuth sign-in — neither fits a server-side pass
 * that just needs the colour and type styles. Two REST calls do: GET
 * /v1/files/:key/styles and GET /v1/files/:key/nodes. (The Variables API
 * would be nicer but needs an Enterprise plan.)
 */

export const FIGMA_API = "https://api.figma.com";

/** The file key from a Figma URL (figma.com/file/<key>/… or /design/<key>/…). Pure. */
export function figmaFileKey(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)figma\.com$/.test(u.hostname)) return null;
    const m = /^\/(?:file|design|proto)\/([A-Za-z0-9]{10,64})(?:\/|$)/.exec(u.pathname);
    return m ? m[1]! : null;
  } catch {
    return /^[A-Za-z0-9]{10,64}$/.test(url) ? url : null;
  }
}

type StyleMeta = { key: string; node_id: string; style_type: "FILL" | "TEXT" | "EFFECT" | "GRID"; name: string };
type NodeDoc = { document?: { fills?: Array<{ type?: string; color?: { r: number; g: number; b: number }; visible?: boolean }>; style?: { fontFamily?: string; fontWeight?: number } } };

export async function fetchFigmaTokens(fileKey: string, token: string, o: { fetch?: typeof fetch; now?: Date } = {}): Promise<FigmaTokens> {
  const f = o.fetch ?? fetch;
  const get = async <T>(path: string): Promise<T> => {
    const r = await f(`${FIGMA_API}${path}`, { headers: { "X-Figma-Token": token }, signal: AbortSignal.timeout(20_000) });
    if (r.status === 403 || r.status === 401) throw new Error("Figma refused the token (it needs read access to this file)");
    if (r.status === 404) throw new Error("Figma can't find that file");
    if (!r.ok) throw new Error(`Figma answered ${r.status}`);
    return (await r.json()) as T;
  };
  const styles = (await get<{ meta?: { styles?: StyleMeta[] } }>(`/v1/files/${encodeURIComponent(fileKey)}/styles`)).meta?.styles ?? [];
  const wanted = styles.filter((s) => s.style_type === "FILL" || s.style_type === "TEXT").slice(0, 80);
  const colors: FigmaTokens["colors"] = [];
  const fonts: FigmaTokens["fonts"] = [];
  if (wanted.length) {
    const nodes = (await get<{ nodes?: Record<string, NodeDoc> }>(`/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${wanted.map((s) => encodeURIComponent(s.node_id)).join(",")}`)).nodes ?? {};
    for (const s of wanted) {
      const d = nodes[s.node_id]?.document;
      if (!d) continue;
      if (s.style_type === "FILL") {
        const fill = d.fills?.find((x) => x.type === "SOLID" && x.visible !== false && x.color);
        if (fill?.color) colors.push({ name: s.name.slice(0, 60), hex: toHex(fill.color.r * 255, fill.color.g * 255, fill.color.b * 255) });
      } else if (d.style?.fontFamily) fonts.push({ name: s.name.slice(0, 60), family: d.style.fontFamily.slice(0, 60), weight: d.style.fontWeight ?? 400 });
    }
  }
  return { fileKey, fetchedAt: (o.now ?? new Date()).toISOString(), colors: colors.slice(0, 40), fonts: fonts.slice(0, 20) };
}
