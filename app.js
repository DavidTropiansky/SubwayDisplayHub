'use strict';

/**
 * Canonical entry point for the complete Subway Display Hub.
 *
 * When this file is launched directly, the Live Map extension is loaded first
 * so it can register its API and page before the core application starts
 * listening. When the extension requires this file, it is already active, so
 * this module simply starts the core application.
 */
if (require.main === module) {
  require('./live-map-extension');
}

require('./app-core');
