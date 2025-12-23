# Virtual Split-Flap Display - NYC Subway Website

## Project Overview
This is a web-based simulation of a split-flap display (Solari board) that shows NYC Subway arrivals in real-time. Users can select any NYC subway station and view live arrival data with animated CSS sprite-based split-flap characters.

**Current State**: Fully functional multi-page website on Replit
**Features**: Station selector with route bullets, real-time arrivals display
**Last Updated**: December 13, 2025

## Architecture

### Website Pages
1. **Home Page** (`public/index.html`)
   - Station selector with search functionality
   - Lists all 499 NYC subway stations from stations.csv
   - Clean, modern UI with gradient background
   - Click any station to view its arrivals

2. **Display Page** (`public/display.html`)
   - Split-flap arrival board for selected station
   - Receives station code and name via URL parameters
   - Auto-updates every 20 seconds
   - Shows: Route, Destination, ETA (minutes), Status
   - "Back to Stations" button to return home

### Backend Components
1. **Python Data Fetcher** (`Solari Board V2.1.py`)
   - Fetches real-time subway data from Transiter API
   - Reads selected station from `current_station.txt` file
   - Updates every 20 seconds in continuous loop
   - Writes data to `output.json`
   - Supports all station codes from stations.csv

2. **Node.js/Express Server** (`app.js`)
   - Serves static frontend files
   - `/api/stations` - Returns list of all stations from stations.csv
   - `/api/arrivals?station=CODE` - Returns arrival data for specified station
   - Updates current_station.txt when station parameter received
   - Reads from `output.json` every 15 seconds (faster than Python's 20s interval)
   - Manages Python subprocess lifecycle
   - Runs on port 5000, bound to 0.0.0.0

### Frontend Components
- **Station Selector** (index.html): Search and select from 499 stations
- **Split-Flap Display** (display.html): Animated arrival board
- **Custom Plugin** (plugins/arrivals/custom.js): Handles API requests with station parameter
- Libraries: jQuery, Underscore.js, Backbone.js

## How It Works

1. User visits home page and sees list of all NYC subway stations
2. User searches/selects a station (e.g., "Times Sq-42 St")
3. Clicks station → redirects to `/display.html?station=127&name=Times Sq-42 St`
4. Display page extracts station code from URL
5. Frontend makes API request to `/api/arrivals?station=127`
6. Backend writes "127" to `current_station.txt`
7. Python script reads file on next iteration (≤20s)
8. Python fetches data for Times Square from Transiter API
9. Python writes arrival data to `output.json`
10. Node.js reads `output.json` and serves via API (every 15s)
11. Frontend displays data with split-flap animation

## Replit Configuration

### Workflow
- **Name**: Split-Flap Display
- **Command**: `bash start.sh`
- **Port**: 5000 (webview)
- **Type**: Combined Python + Node.js process

### Deployment
- **Target**: VM (always-on)
- **Reason**: Maintains continuous data fetching from API
- **Command**: `bash start.sh`

### Dependencies
- **Node.js**: express
- **Python**: requests

## Key Files
- `start.sh` - Startup script that runs both Python and Node.js
- `app.js` - Express server with station selection API
- `Solari Board V2.1.py` - Dynamic MTA data fetcher
- `public/index.html` - Station selector home page
- `public/display.html` - Split-flap display page
- `public/plugins/arrivals/custom.js` - Frontend API integration
- `stations.csv` - Complete list of 499 NYC subway stations
- `current_station.txt` - Currently selected station (updated by API)
- `output.json` - Data cache (git-ignored)

## Customization Options

### Adjust Number of Rows
- Line 30 in `app.js`
- Lines 109 & 112 in `public/display.html`

### Change Refresh Intervals
- Python: Line 132 in `Solari Board V2.1.py` (currently 20s)
- Node.js: Line 79 in `app.js` (currently 15s)
- Frontend: Line 116 in `public/display.html` (currently 20s)

### Sort Order
- Line 110-111 in `public/display.html`
- Options: 'scheduled' (by time), 'line' (by route), 'terminal' (by destination)

## Recent Changes
- 2025-11-25: Initial Replit setup
  - Configured app.js to bind to 0.0.0.0:5000
  - Created start.sh to run both processes
  - Set up workflow for webview output
  - Configured VM deployment for always-on service
  - Added comprehensive .gitignore
  - Fixed Python loop bug (moved time.sleep outside main function)
  - Optimized Node.js refresh to 15s (faster than Python's 20s interval)

- 2025-11-25: Multi-station website conversion
  - Created station selector home page with search
  - Converted to multi-page website architecture
  - Added dynamic station selection via current_station.txt
  - Modified Python script to read station from file
  - Added /api/stations endpoint for station list
  - Updated /api/arrivals to accept station parameter
  - Added back button to display page
  - Full CSV parsing and station management (499 stations)

- 2025-11-25: Data freshness improvements
  - Added station_id verification to prevent serving stale data
  - Modified Python to write station metadata (station_id, timestamp) to output.json
  - Backend verifies data matches requested station before serving
  - Returns loading state when data doesn't match requested station
  - Implemented per-process tracking to prevent restart conflicts
  - Added immediate cache refresh (6s, 12s) after station changes
  - Typical latency after station change: 6-12 seconds

- 2025-12-13: Route bullets on homepage
  - Added `/api/stations/:stationId/routes` endpoint to fetch routes from Transiter API
  - Homepage now shows colored MTA route bullets instead of station IDs
  - Route bullets use official MTA color scheme (red for 1/2/3, green for 4/5/6, etc.)
  - Frontend caches route data to minimize API calls
  - Routes fetched asynchronously with "Loading routes..." placeholder

- 2025-12-13: Station consolidation and route filtering
  - Homepage now consolidates stations by parent_id (e.g., 14 St-Union Sq appears once instead of 3 times)
  - `/api/stations` returns consolidated stations with platform_ids array
  - Station page replaces "This Platform Only" / "All Lines" toggle with route bullet toggles
  - Users can click route bullets to filter which train lines to display
  - Added `?routes=` query parameter to arrivals API for server-side filtering
  - All routes are selected by default; clicking toggles visibility

- 2025-12-13: UI enhancements
  - Route column displays circular bullets with white borders (matching filter toggle style)
  - Fullscreen button enters fullscreen mode and hides all navigation elements
  - Press Escape to exit fullscreen and restore elements
  - Dynamic row count adjusts to screen size (no scrolling needed)
  - Rows recalculate on window resize and orientation change

- 2025-12-14: Arriving now highlight
  - Trains with 0 minute ETA now display with white background and black text
  - Visual indicator helps users quickly spot trains that are arriving immediately

## Known Limitations
- **Station change latency**: After selecting a new station, the display shows empty data for 6-12 seconds while fresh data is fetched. This is due to the polling-based architecture where Node.js polls output.json at intervals rather than receiving immediate notification when Python finishes fetching data.
- **Potential improvement**: Implementing an event-driven architecture (file watchers, IPC, or synchronous polling) would reduce latency to near-zero, but would require significant architectural changes to the current polling-based system.

## Credits
- Split-flap template from [baspete's project](https://github.com/baspete/Split-Flap/)
- Transit data from [Transiter](https://github.com/jamespfennell/transiter)
