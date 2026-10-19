declare module '@novnc/novnc' {
  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: { wsProtocols?: string[] });
    scaleViewport: boolean;
    resizeSession: boolean;
    focusOnClick: boolean;
    addEventListener(type: string, listener: (event: Event) => void): void;
    disconnect(): void;
    focus(): void;
  }
}
