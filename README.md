# SubwayDisplayHub

Unified website for modern, split-flap, strip-map, LED, LCD, NYC Ferry, Citi Bike, and live NYC subway displays.

## Running the complete project

```bash
npm install
npm start
```

The canonical entry point is `app.js`. It loads the Live Map extension before starting the original hub application, so all existing displays and the new Live Map run from one process. `server.js` remains as a backward-compatible entry point for existing deployments.

## Live Map

- Page: `/live-map`
- API: `/api/live-map`
- Views: entire system map or line-by-line strip map
- Refresh: every 15 seconds

A train is shown at the station tied to its next/current stop when its ETA is 0 minutes (0–59 seconds). The position is station-level and should not be interpreted as precise tunnel GPS.

## Runtime files

- `app.js` — canonical application entry point
- `app-core.js` — original Subway Display Hub server and routes
- `live-map-extension.js` — Live Map API, page registration, and landing-page integration
- `server.js` — compatibility entry point
- `live-map.html` — Live Map user interface
