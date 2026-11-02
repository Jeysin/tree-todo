/** 状态栏缩放控制与 Mind Elixir 实例之间的薄注册表（避免把实例塞进 Zustand）。 */
export interface MindMapControls {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
}

let controls: MindMapControls | null = null;

export function setMindMapControls(next: MindMapControls | null): void {
  controls = next;
}

export function mindMapZoomIn(): void {
  controls?.zoomIn();
}

export function mindMapZoomOut(): void {
  controls?.zoomOut();
}

export function mindMapFit(): void {
  controls?.fit();
}
