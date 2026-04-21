export class BasePlugin {
  constructor(hotInstance) {
    this.hot = hotInstance;
    this.enabled = false;
  }

  isEnabled() {
    return this.enabled;
  }

  enablePlugin() {
    this.enabled = true;
  }

  disablePlugin() {
    this.enabled = false;
  }

  destroy() {}
}
