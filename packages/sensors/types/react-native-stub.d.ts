// Minimal types so this package typechecks on its own; apps use their real
// react / react-native types (this folder isn't shipped to them).
declare module "react" {
  export function useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
  export function useRef<T>(initial: T): { current: T };
}
declare module "react-native" {
  export const Platform: { OS: "ios" | "android" | "web" | "windows" | "macos"; Version: string | number };
  export const Dimensions: { get(dim: "window" | "screen"): { width: number; height: number } };
  export const Appearance: { getColorScheme(): "light" | "dark" | null | undefined };
  export const PixelRatio: { getFontScale(): number };
  export const Linking: { getInitialURL(): Promise<string | null> };
  export const AppState: { addEventListener(type: "change", cb: (state: string) => void): { remove(): void } };
}
