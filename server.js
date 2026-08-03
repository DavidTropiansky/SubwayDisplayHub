'use strict';

/**
 * Backward-compatible server entry point.
 * New deployments start through app.js, but existing Render or local commands
 * that still run `node server.js` continue to load the complete application.
 */
require('./live-map-extension');
