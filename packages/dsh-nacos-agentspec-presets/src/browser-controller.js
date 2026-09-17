import { NacosAgentSpecBrowser } from './index.js';

/**
 * Host-side workflow controller for the future DSH Web client module.
 * It keeps the product semantics testable without doing work at plugin startup:
 * - list() performs metadata-only discovery;
 * - download() materializes exactly one selected preset;
 * - applyToNewSession() is intentionally an adapter seam, because creating and
 *   staging a Web session belongs to DSH's browser-side session controller.
 */
export class NacosPresetBrowserController {
  constructor(config, dependencies = {}) {
    this.browser = new NacosAgentSpecBrowser(config, dependencies);
    this.applyPresetToNewSession = dependencies.applyPresetToNewSession;
  }

  list(keyword = '') { return this.browser.list({ keyword }); }
  download(id) { return this.browser.download(id); }

  async applyToNewSession(id) {
    if (typeof this.applyPresetToNewSession !== 'function') {
      throw new Error('Nacos preset was downloaded, but no DSH Web new-session adapter is installed.');
    }
    return this.applyPresetToNewSession(id);
  }
}
