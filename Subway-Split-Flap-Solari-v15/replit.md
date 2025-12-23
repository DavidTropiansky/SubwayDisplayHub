# Virtual Split-Flap Display - NYC Subway Website

## Project Overview
This is a web-based simulation of a split-flap display (Solari board) that shows NYC Subway arrivals in real-time. Users can select any NYC subway station and view live arrival data with animated CSS sprite-based split-flap characters.

**Current State**: Fully functional multi-page website on Replit
**Features**: Station selector home page, real-time split-flap display
**Last Updated**: November 25, 2025

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

### 2025-12-18: Enhanced Display Page with Header
- **Added fixed header** with weather, time, station name, and routes
- **Live weather data** - Fetches NYC weather from NOAA API with emoji indicators
- **Station name display** - Shows selected station name in header
- **Route badges** - Displays all station routes with authentic MTA colors
- **Live time** - Updates every minute
- **Control buttons** - Back to Stations (bottom left), Fullscreen (bottom right)
- **Preserved split-flap animation** - Full animated display maintained below header

### 2025-12-18: Enhanced Backend Integration
- **Replaced Python subprocess** with direct Transiter API calls via node-fetch
- **Improved station management**: Uses parent_id for consolidated stations
- **MTA route colors**: Built-in color scheme for all subway lines
- **Advanced caching**: 20s cache for arrivals, 5 min cache for routes
- **Service status integration**: Fetches and displays real-time service alerts
- **Multi-platform support**: Merges arrivals from all platforms in a station complex
- **Cleaner API structure**: `/api/stations/:stationId/arrivals` endpoint

### Previous Updates
- 2025-11-25: Multi-station website with station selector home page
- 2025-11-25: Dynamic station selection and CSV parsing for 499 stations
- 2025-11-25: Initial Replit setup with Express server on port 5000

## Architecture Changes (December 2025)
- **Removed**: Python subprocess (`Solari Board V2.1.py`), current_station.txt, output.json caching layer
- **Added**: Direct Node.js/Transiter API integration with dual-level caching
- **Benefit**: Faster response times, simpler deployment, no subprocess overhead

## Credits
- Split-flap template from [baspete's project](https://github.com/baspete/Split-Flap/)
- Transit data from [Transiter](https://github.com/jamespfennell/transiter)
