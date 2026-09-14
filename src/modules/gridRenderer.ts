export class GridRenderer {
  constructor(private readonly host: HTMLElement) {
    host.textContent = "Hello world";
  }

  destroy(): void {
    this.host.replaceChildren();
  }
}
