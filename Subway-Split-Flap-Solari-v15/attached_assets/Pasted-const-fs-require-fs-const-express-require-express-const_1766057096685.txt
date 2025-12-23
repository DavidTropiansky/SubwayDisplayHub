const fs = require('fs');
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());

const stationsFilePath = path.join(__dirname, 'stations.csv');

// Cache for station arrivals (station_id -> {data, timestamp})
const arrivalsCache = {};
const CACHE_TTL = 20000; // 20 seconds

// MTA color scheme (background + text) for each route
const routeColors = {
  '1': { bg: '#EE352E', text: 'white' },
  '2': { bg: '#EE352E', text: 'white' },
  '3': { bg: '#EE352E', text: 'white' },
  '4': { bg: '#00933C', text: 'white' },
  '5': { bg: '#00933C', text: 'white' },
  '6': { bg: '#00933C', text: 'white' },
  '6X': { bg: '#00933C', text: 'white' },
  '7': { bg: '#B933AD', text: 'white' },
  '7X': { bg: '#B933AD', text: 'white' },
  'A': { bg: '#0039A6', text: 'white' },
  'C': { bg: '#0039A6', text: 'white' },
  'E': { bg: '#0039A6', text: 'white' },
  'B': { bg: '#FF6319', text: 'white' },
  'D': { bg: '#FF6319', text: 'white' },
  'F': { bg: '#FF6319', text: 'white' },
  'FX': { bg: '#FF6319', text: 'white' },
  'M': { bg: '#FF6319', text: 'white' },
  'G': { bg: '#6CBE45', text: 'white' },
  'J': { bg: '#996633', text: 'white' },
  'Z': { bg: '#996633', text: 'white' },
  'L': { bg: '#A7A9AC', text: 'white' },
  'N': { bg: '#FCCC0A', text: 'black' },
  'Q': { bg: '#FCCC0A', text: 'black' },
  'R': { bg: '#FCCC0A', text: 'black' },
  'W': { bg: '#FCCC0A', text: 'black' },
  'T': { bg: '#00ADD0', text: 'white' },
  'GS': { bg: '#808183', text: 'white' }
};

// Station data structures
let stations = [];
let stationMap = {}; // id -> station object
let parentMap = {}; // parent_id -> [station ids]

// Parse stations CSV with parent_id
function loadStations() {
  try {
    const raw = fs.readFileSync(stationsFilePath, 'utf8');
    const lines = raw.trim().split('\n');
    const stationsList = [];

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length >= 5) {
        const station = {
          id: parts[0],
          name: parts[1],
          lat: parts[2],
          lon: parts[3],
          parent_id: parts[4]
        };
        stationsList.push(station);
        stationMap[station.id] = station;

        // Build parent map
        if (!parentMap[station.parent_id]) {
          parentMap[station.parent_id] = [];
        }
        if (!parentMap[station.parent_id].includes(station.id)) {
          parentMap[station.parent_id].push(station.id);
        }
      }
    }
    return stationsList.sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    console.error('Error reading stations file:', err);
    return [];
  }
}

// Get all station IDs in the same complex (by parent_id)
function getRelatedStationIds(stationId) {
  const station = stationMap[stationId];
  if (!station) return [stationId];

  const parentId = station.parent_id;
  return parentMap[parentId] || [stationId];
}

// Fetch arrivals from Transiter API for a single station
async function fetchSingleStationArrivals(stationId) {
  const now = Date.now();

  // Check cache
  if (arrivalsCache[stationId] && (now - arrivalsCache[stationId].timestamp) < CACHE_TTL) {
    return arrivalsCache[stationId].data;
  }

  try {
    const fetch = (await import('node-fetch')).default;

    // Fetch stop times
    const stopUrl = `https://demo.transiter.dev/systems/us-ny-subway/stops/${stationId}`;
    const stopResp = await fetch(stopUrl);
    const stopData = await stopResp.json();

    // Process arrivals
    const arrivals = [];
    const stationName = stopData.name || stationId;

    for (const stopTime of (stopData.stopTimes || [])) {
      if (stopTime.departure && stopTime.departure.time) {
        const departureTime = parseInt(stopTime.departure.time);
        const secondsToLeave = departureTime - (now / 1000);
        const arrivalMinutes = Math.floor(secondsToLeave / 60);

        if (arrivalMinutes >= 0) {
          arrivals.push({
            route_id: stopTime.trip?.route?.id || 'Unknown',
            arrival_time: arrivalMinutes,
            current_stop: stationName,
            last_stop_name: stopTime.trip?.destination?.name || 'Unknown',
            service_status: 'Good Service'
          });
        }
      }
    }

    // Sort by arrival time
    arrivals.sort((a, b) => a.arrival_time - b.arrival_time);

    // Cache results
    arrivalsCache[stationId] = {
      data: { stationName, arrivals },
      timestamp: now
    };

    return { stationName, arrivals };
  } catch (err) {
    console.error(`Error fetching arrivals for ${stationId}:`, err);
    return { stationName: stationId, arrivals: [] };
  }
}

// Fetch arrivals for multiple stations (station complex)
async function fetchMultiStationArrivals(stationIds) {
  const results = await Promise.all(stationIds.map(id => fetchSingleStationArrivals(id)));

  // Merge all arrivals
  let allArrivals = [];
  let stationName = '';

  for (const result of results) {
    if (!stationName && result.stationName) {
      stationName = result.stationName;
    }
    allArrivals = allArrivals.concat(result.arrivals);
  }

  // Sort by arrival time
  allArrivals.sort((a, b) => a.arrival_time - b.arrival_time);

  return { stationName, arrivals: allArrivals };
}

// Fetch service status
async function fetchServiceStatus() {
  try {
    const fetch = (await import('node-fetch')).default;
    const routesUrl = 'https://demo.transiter.dev/systems/us-ny-subway/routes';
    const routesResp = await fetch(routesUrl);
    const routesData = await routesResp.json();

    const serviceStatus = {};
    for (const route of (routesData.routes || [])) {
      const alerts = route.alerts || [];
      if (alerts.length === 0) {
        serviceStatus[route.id] = 'Good Service';
      } else {
        const hasDelay = alerts.some(a => 
          (a.cause || '').toUpperCase().includes('MAINTENANCE') ||
          (a.effect || '').toUpperCase().includes('MAINTENANCE')
        );
        serviceStatus[route.id] = hasDelay ? 'Service Change' : 'Delays';
      }
    }
    return serviceStatus;
  } catch (err) {
    console.error('Error fetching service status:', err);
    return {};
  }
}

// Load stations
stations = loadStations();
console.log(`Loaded ${stations.length} stations`);

// Cache for station routes
const stationRoutesCache = {};
const ROUTES_CACHE_TTL = 300000; // 5 minutes

// Fetch routes served by a station from Transiter API
async function fetchStationRoutes(stationId) {
  const now = Date.now();

  // Check cache
  if (stationRoutesCache[stationId] && (now - stationRoutesCache[stationId].timestamp) < ROUTES_CACHE_TTL) {
    return stationRoutesCache[stationId].data;
  }

  try {
    const fetch = (await import('node-fetch')).default;
    const stopUrl = `https://demo.transiter.dev/systems/us-ny-subway/stops/${stationId}`;
    const stopResp = await fetch(stopUrl);
    const stopData = await stopResp.json();

    // Extract unique routes from stop times
    const routes = new Set();
    for (const stopTime of (stopData.stopTimes || [])) {
      if (stopTime.trip?.route?.id) {
        routes.add(stopTime.trip.route.id);
      }
    }

    const routesList = Array.from(routes).sort();

    // Cache results
    stationRoutesCache[stationId] = {
      data: routesList,
      timestamp: now
    };

    return routesList;
  } catch (err) {
    console.error(`Error fetching routes for ${stationId}:`, err);
    return [];
  }
}

// API: Get all stations (consolidated by parent_id)
app.get('/api/stations', (req, res) => {
  // Group stations by parent_id and return one entry per parent
  const consolidated = {};
  for (const s of stations) {
    if (!consolidated[s.parent_id]) {
      consolidated[s.parent_id] = {
        id: s.parent_id, // Use parent_id as the main identifier
        name: s.name,
        platform_ids: []
      };
    }
    consolidated[s.parent_id].platform_ids.push(s.id);
  }

  // Sort by name and return as array
  const result = Object.values(consolidated).sort((a, b) => a.name.localeCompare(b.name));
  res.json(result);
});

// API: Get routes for a station (uses parent_id to get all platforms)
app.get('/api/stations/:stationId/routes', async (req, res) => {
  const { stationId } = req.params;

  // stationId could be a parent_id, so get all platform IDs
  let platformIds = parentMap[stationId] || [];
  if (platformIds.length === 0) {
    // It might be a direct station ID
    platformIds = getRelatedStationIds(stationId);
  }

  // Fetch routes for all platforms
  const allRoutes = new Set();
  const routePromises = platformIds.map(id => fetchStationRoutes(id));
  const routeResults = await Promise.all(routePromises);

  for (const routes of routeResults) {
    for (const route of routes) {
      allRoutes.add(route);
    }
  }

  res.json(Array.from(allRoutes).sort());
});

// API: Get station info including related stations (works with parent_id)
app.get('/api/stations/:stationId', (req, res) => {
  const { stationId } = req.params;

  // stationId could be a parent_id
  let platformIds = parentMap[stationId] || [];
  let stationName = '';

  if (platformIds.length > 0) {
    // It's a parent_id
    const firstStation = stationMap[platformIds[0]];
    stationName = firstStation ? firstStation.name : stationId;
  } else {
    // It's a direct station ID
    const station = stationMap[stationId];
    if (!station) {
      return res.status(404).json({ error: 'Station not found' });
    }
    stationName = station.name;
    platformIds = getRelatedStationIds(stationId);
  }

  res.json({
    id: stationId,
    name: stationName,
    platformIds: platformIds
  });
});

// API: Get arrivals for station (fetches all platforms, optional route filter)
app.get('/api/stations/:stationId/arrivals', async (req, res) => {
  const { stationId } = req.params;
  const routeFilter = req.query.routes ? req.query.routes.split(',') : null;

  // Get all platform IDs for this station
  let platformIds = parentMap[stationId] || [];
  if (platformIds.length === 0) {
    platformIds = getRelatedStationIds(stationId);
  }

  // Fetch arrivals from all platforms
  const data = await fetchMultiStationArrivals(platformIds);

  // Get service status
  const serviceStatus = await fetchServiceStatus();

  // Apply service status and filter by routes if specified
  let arrivalsWithStatus = data.arrivals.map(entry => ({
    ...entry,
    service_status: serviceStatus[entry.route_id] || 'Good Service'
  }));

  // Filter by routes if specified
  if (routeFilter && routeFilter.length > 0) {
    arrivalsWithStatus = arrivalsWithStatus.filter(entry => 
      routeFilter.includes(entry.route_id)
    );
  }

  // Always sort by ETA before returning
  arrivalsWithStatus.sort((a, b) => a.arrival_time - b.arrival_time);

  const result = {
    stationName: data.stationName,
    platformIds: platformIds,
    data: arrivalsWithStatus.slice(0, 30).map(entry => ({
      line: entry.route_id,
      stop: entry.current_stop,
      terminal: entry.last_stop_name,
      scheduled: entry.arrival_time,
      status: entry.service_status
    }))
  };

  res.json(result);
});

// Homepage - Station selector
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>NYC Subway Station Arrivals</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 20px;
      font-family: Arial, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      color: white;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
      text-align: center;
    }
    h1 {
      font-size: 2.5em;
      margin-bottom: 10px;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
    }
    .subtitle {
      color: #aaa;
      margin-bottom: 40px;
      font-size: 1.1em;
    }
    .search-container {
      position: relative;
      margin-bottom: 20px;
    }
    #search-input {
      width: 100%;
      padding: 15px 20px;
      font-size: 18px;
      border: none;
      border-radius: 10px;
      background: white;
      color: #333;
    }
    #search-input:focus {
      outline: 3px solid #4a90d9;
    }
    .stations-list {
      background: rgba(255,255,255,0.1);
      border-radius: 10px;
      max-height: 500px;
      overflow-y: auto;
      text-align: left;
    }
    .station-item {
      padding: 15px 20px;
      border-bottom: 1px solid rgba(255,255,255,0.1);
      cursor: pointer;
      transition: background 0.2s;
    }
    .station-item:hover {
      background: rgba(255,255,255,0.2);
    }
    .station-item:last-child {
      border-bottom: none;
    }
    .station-name {
      font-size: 1.1em;
      font-weight: bold;
    }
    .station-routes {
      margin-top: 5px;
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .route-bullet {
      display: inline-flex;
      height: 28px;
      width: 28px;
      line-height: 28px;
      justify-content: center;
      align-items: center;
      border-radius: 50%;
      background-color: #666;
      color: white;
      font-size: 14px;
      font-weight: bold;
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    }
    .no-results {
      padding: 20px;
      color: #888;
      text-align: center;
    }
    .hint {
      color: #666;
      font-size: 0.9em;
      margin-top: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>NYC Subway Arrivals</h1>
    <p class="subtitle">Search for a station to view real-time train arrivals</p>

    <div class="search-container">
      <input type="text" id="search-input" placeholder="Search for a station..." autocomplete="off" />
    </div>

    <div class="stations-list" id="stations-list"></div>

    <p class="hint">Click on a station to open arrivals in a new tab</p>
  </div>

  <script>
    let allStations = [];
    const stationRoutesCache = {};

    const routeColors = {
      '1': { bg: '#EE352E', text: 'white' },
      '2': { bg: '#EE352E', text: 'white' },
      '3': { bg: '#EE352E', text: 'white' },
      '4': { bg: '#00933C', text: 'white' },
      '5': { bg: '#00933C', text: 'white' },
      '6': { bg: '#00933C', text: 'white' },
      '6X': { bg: '#00933C', text: 'white' },
      '7': { bg: '#B933AD', text: 'white' },
      '7X': { bg: '#B933AD', text: 'white' },
      'A': { bg: '#0039A6', text: 'white' },
      'C': { bg: '#0039A6', text: 'white' },
      'E': { bg: '#0039A6', text: 'white' },
      'B': { bg: '#FF6319', text: 'white' },
      'D': { bg: '#FF6319', text: 'white' },
      'F': { bg: '#FF6319', text: 'white' },
      'FX': { bg: '#FF6319', text: 'white' },
      'M': { bg: '#FF6319', text: 'white' },
      'G': { bg: '#6CBE45', text: 'white' },
      'J': { bg: '#996633', text: 'white' },
      'Z': { bg: '#996633', text: 'white' },
      'L': { bg: '#A7A9AC', text: 'white' },
      'N': { bg: '#FCCC0A', text: 'black' },
      'Q': { bg: '#FCCC0A', text: 'black' },
      'R': { bg: '#FCCC0A', text: 'black' },
      'W': { bg: '#FCCC0A', text: 'black' },
      'T': { bg: '#00ADD0', text: 'white' },
      'GS': { bg: '#808183', text: 'white' },
      'SI': { bg: '#0039A6', text: 'white' },
      'SIR': { bg: '#0039A6', text: 'white' },
      'FS': { bg: '#808183', text: 'white' },
      'H': { bg: '#808183', text: 'white' }
    };

    async function loadStations() {
      try {
        const resp = await fetch('/api/stations');
        allStations = await resp.json();
        renderStations(allStations.slice(0, 50));
      } catch (err) {
        console.error('Error loading stations:', err);
      }
    }

    async function fetchStationRoutes(stationId) {
      if (stationRoutesCache[stationId]) {
        return stationRoutesCache[stationId];
      }
      try {
        const resp = await fetch('/api/stations/' + stationId + '/routes');
        const routes = await resp.json();
        stationRoutesCache[stationId] = routes;
        return routes;
      } catch (err) {
        console.error('Error fetching routes for ' + stationId + ':', err);
        return [];
      }
    }

    function createRouteBullets(routes) {
      return routes.map(route => {
        const colors = routeColors[route] || { bg: '#666', text: 'white' };
        return '<span class="route-bullet" style="background-color: ' + colors.bg + '; color: ' + colors.text + ';">' + route + '</span>';
      }).join('');
    }

    function renderStations(stations) {
      const list = document.getElementById('stations-list');

      if (stations.length === 0) {
        list.innerHTML = '<div class="no-results">No stations found</div>';
        return;
      }

      list.innerHTML = stations.map(s => 
        '<div class="station-item" data-id="' + s.id + '">' +
          '<div class="station-name">' + escapeHtml(s.name) + '</div>' +
          '<div class="station-routes" id="routes-' + s.id + '"><span style="color:#888;font-size:12px;">Loading routes...</span></div>' +
        '</div>'
      ).join('');

      stations.forEach(s => {
        fetchStationRoutes(s.id).then(routes => {
          const el = document.getElementById('routes-' + s.id);
          if (el) {
            if (routes.length > 0) {
              el.innerHTML = createRouteBullets(routes);
            } else {
              el.innerHTML = '<span style="color:#888;font-size:12px;">No active routes</span>';
            }
          }
        });
      });
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    document.getElementById('search-input').addEventListener('input', function(e) {
      const query = e.target.value.toLowerCase().trim();

      if (!query) {
        renderStations(allStations.slice(0, 50));
        return;
      }

      const filtered = allStations.filter(s => 
        s.name.toLowerCase().includes(query) || 
        s.id.toLowerCase().includes(query)
      );

      renderStations(filtered.slice(0, 50));
    });

    document.getElementById('stations-list').addEventListener('click', function(e) {
      const item = e.target.closest('.station-item');
      if (item) {
        const stationId = item.dataset.id;
        window.open('/station/' + stationId, '_blank');
      }
    });

    loadStations();
  </script>
</body>
</html>
  `);
});

// Station arrivals page
app.get('/station/:stationId', (req, res) => {
  const { stationId } = req.params;

  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Station Arrivals</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    html, body {
      margin: 0; 
      padding: 0; 
      font-family: Arial, sans-serif;
      font-size: 20px;
      font-weight: bold;
      text-align: center;
      background-color: black;
      color: white;
      height: 100vh;
      overflow: hidden;
    }
    #header-container {
      position: relative;
      width: 100%;
      padding-top: 10px;
    }
    #time-display {
      position: fixed;
      right: 10px;
      top: 10px;
      font-size: 20px;
      font-weight: bold;
      color: white;
      font-family: Arial, sans-serif;
      z-index: 100;
    }
    #weather-display {
      position: fixed;
      left: 10px;
      top: 10px;
      font-size: 20px;
      font-weight: bold;
      color: white;
      text-align: left;
      white-space: nowrap;
      font-family: Arial, sans-serif;
      z-index: 100;
    }
    h1 {
      margin: 5px 0;
      font-size: 28px;
      text-decoration: overline;
    }
    .back-link {
      position: fixed;
      left: 10px;
      top: 45px;
      color: #4a90d9;
      text-decoration: none;
      font-size: 16px;
    }
    .back-link:hover {
      text-decoration: underline;
    }
    .fullscreen-btn {
      position: fixed;
      right: 10px;
      top: 45px;
      background: transparent;
      border: 2px solid #4a90d9;
      color: #4a90d9;
      padding: 8px 16px;
      font-size: 14px;
      font-weight: bold;
      border-radius: 5px;
      cursor: pointer;
      transition: all 0.2s;
      z-index: 1000;
    }
    .fullscreen-btn:hover {
      background: #4a90d9;
      color: white;
    }
    .fullscreen-hide {
      display: none !important;
    }
    .route-toggles {
      margin: 8px 0;
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 6px;
      max-height: 60px;
      overflow-y: auto;
    }
    .route-toggle {
      display: inline-flex;
      height: 32px;
      width: 32px;
      justify-content: center;
      align-items: center;
      border-radius: 50%;
      font-size: 16px;
      font-weight: bold;
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      cursor: pointer;
      border: 2px solid transparent;
      transition: all 0.2s;
      opacity: 0.4;
    }
    .route-toggle.active {
      opacity: 1;
      border-color: white;
      box-shadow: 0 0 10px rgba(255,255,255,0.5);
    }
    .route-toggle:hover {
      opacity: 0.8;
    }
    .filter-hint {
      font-size: 12px;
      color: #888;
      margin-bottom: 5px;
    }
    .table-route-bullet {
      display: inline-flex;
      height: 36px;
      width: 36px;
      justify-content: center;
      align-items: center;
      border-radius: 50%;
      font-size: 18px;
      font-weight: bold;
      font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      border: 3px solid white;
    }
    table {
      width: 99%;
      margin: 5px auto;
      border-collapse: collapse;
    }
    th, td {
      border: 1px solid black;
      padding: 8px;
      text-align: center;
      font-size: 20px;
      font-weight: bold;
    }
    th {
      background-color: gray;
      color: white;
    }
    tbody tr {
      cursor: pointer;
      transition: all 0.2s;
    }
    tbody tr.highlighted {
      background-color: #FF00FF !important;
      box-shadow: 0 0 15px #FF00FF;
    }
    tbody tr.highlighted td {
      background-color: #FF00FF !important;
      color: white !important;
    }
    tbody tr.highlighted .table-route-bullet {
      border-color: white !important;
    }
    #loading {
      color: yellow;
      font-size: 18px;
      margin: 10px;
    }
  </style>
</head>
<body>
  <div id="header-container">
    <a href="/" class="back-link" id="back-link">&lt; Back to Stations</a>
    <button class="fullscreen-btn" id="fullscreen-btn">Fullscreen</button>
    <div id="time-display"></div>
    <div id="weather-display">Loading weather...</div>
    <h1 id="station-header">Loading...</h1>
    <div class="route-toggles" id="route-toggles"></div>
    <div class="filter-hint" id="filter-hint">Click routes to filter arrivals</div>
  </div>
  <div id="loading">Fetching arrivals...</div>
  <table>
    <thead>
      <tr>
        <th>Route</th>
        <th>Destination</th>
        <th>ETA (min)</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody id="arrival-table-body"></tbody>
  </table>
  <script>
    const stationId = '${stationId}';
    let availableRoutes = [];
    let selectedRoutes = new Set(); // Empty = show all
    let cachedArrivals = []; // Store fetched arrivals for re-rendering on resize
    let maxRows = 10; // Will be calculated dynamically
    let highlightedTrains = new Map(); // Track highlighted trains: key = trainId, value = { line, terminal, originalETA, timestamp }

    function updateTime() {
      const now = new Date();
      let hours = now.getHours();
      const minutes = now.getMinutes();
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12 || 12;
      const minutesStr = minutes < 10 ? '0' + minutes : minutes;

      const timeStr = hours + ':' + minutesStr + ' ' + ampm;
      document.getElementById('time-display').innerText = timeStr;
    }
    updateTime();
    setInterval(updateTime, 60000);

    // Weather condition to emoji mapping with colors
    function getWeatherEmoji(condition) {
      const conditionLower = condition.toLowerCase();

      // Sunny/Clear
      if (conditionLower.includes('sunny') || conditionLower.includes('clear')) {
        return { emoji: '☀', color: '#FFD700' }; // Gold
      }
      // Partly Cloudy
      if (conditionLower.includes('partly cloudy') || conditionLower.includes('mostly sunny')) {
        return { emoji: '⛅', color: '#FDB813' }; // Orange-yellow
      }
      // Cloudy
      if (conditionLower.includes('cloudy') || conditionLower.includes('overcast')) {
        return { emoji: '☁', color: '#B0B0B0' }; // Gray
      }
      // Rain
      if (conditionLower.includes('rain') && !conditionLower.includes('thunder')) {
        return { emoji: '🌧', color: '#4682B4' }; // Steel blue
      }
      // Drizzle
      if (conditionLower.includes('drizzle') || conditionLower.includes('sprinkle')) {
        return { emoji: '🌦', color: '#6495ED' }; // Cornflower blue
      }
      // Thunderstorm
      if (conditionLower.includes('thunder') || conditionLower.includes('storm')) {
        return { emoji: '⛈', color: '#8B008B' }; // Dark magenta
      }
      // Snow
      if (conditionLower.includes('snow') || conditionLower.includes('flurr')) {
        return { emoji: '🌨', color: '#E0FFFF' }; // Light cyan
      }
      // Sleet/Freezing Rain
      if (conditionLower.includes('sleet') || conditionLower.includes('freezing')) {
        return { emoji: '🌧', color: '#87CEEB' }; // Sky blue
      }
      // Fog/Mist
      if (conditionLower.includes('fog') || conditionLower.includes('mist') || conditionLower.includes('haze')) {
        return { emoji: '🌫', color: '#DCDCDC' }; // Gainsboro
      }
      // Windy
      if (conditionLower.includes('wind') || conditionLower.includes('breezy')) {
        return { emoji: '💨', color: '#87CEEB' }; // Sky blue
      }
      // Hot
      if (conditionLower.includes('hot')) {
        return { emoji: '🌡', color: '#FF4500' }; // Orange red
      }
      // Cold
      if (conditionLower.includes('cold')) {
        return { emoji: '❄', color: '#00CED1' }; // Dark turquoise
      }
      // Default
      return { emoji: '🌤', color: '#FFA500' }; // Orange
    }

    // Fetch weather data for New York City
    async function fetchWeather() {
      try {
        // NYC coordinates (approximate center)
        const lat = 40.7128;
        const lon = -74.0060;

        // First, get the grid point
        const pointResp = await fetch('https://api.weather.gov/points/' + lat + ',' + lon);
        const pointData = await pointResp.json();

        // Get the forecast URL and observation stations
        const forecastUrl = pointData.properties.forecast;
        const observationStationsUrl = pointData.properties.observationStations;

        // Fetch forecast
        const forecastResp = await fetch(forecastUrl);
        const forecastData = await forecastResp.json();
        const currentPeriod = forecastData.properties.periods[0];

        // Fetch current observations
        const stationsResp = await fetch(observationStationsUrl);
        const stationsData = await stationsResp.json();
        const stationId = stationsData.features[0].properties.stationIdentifier;

        const obsResp = await fetch('https://api.weather.gov/stations/' + stationId + '/observations/latest');
        const obsData = await obsResp.json();

        // Get current temp
        const temp = obsData.properties.temperature.value;
        const tempF = temp ? Math.round(temp * 9/5 + 32) : currentPeriod.temperature;

        // Get conditions
        const conditions = obsData.properties.textDescription || currentPeriod.shortForecast || 'Unknown';

        // Get weather emoji and color
        const weatherInfo = getWeatherEmoji(conditions);

        // Update display with colored emoji and temperature
        const weatherDisplay = document.getElementById('weather-display');
        weatherDisplay.innerHTML = '<span style="color: ' + weatherInfo.color + ';">' + weatherInfo.emoji + '</span> ' + tempF + '°F';
      } catch (err) {
        console.error('Error fetching weather:', err);
        document.getElementById('weather-display').textContent = 'Weather unavailable';
      }
    }

    fetchWeather();
    setInterval(fetchWeather, 600000); // Update every 10 minutes

    // Fullscreen functionality
    let isFullscreen = false;

    function toggleFullscreen() {
      const backLink = document.getElementById('back-link');
      const filterHint = document.getElementById('filter-hint');
      const fullscreenBtn = document.getElementById('fullscreen-btn');

      if (!isFullscreen) {
        // Enter fullscreen
        if (document.documentElement.requestFullscreen) {
          document.documentElement.requestFullscreen();
        } else if (document.documentElement.webkitRequestFullscreen) {
          document.documentElement.webkitRequestFullscreen();
        } else if (document.documentElement.msRequestFullscreen) {
          document.documentElement.msRequestFullscreen();
        }
        backLink.classList.add('fullscreen-hide');
        filterHint.classList.add('fullscreen-hide');
        fullscreenBtn.classList.add('fullscreen-hide');

        // Time and weather stay at top (already at 10px)

        isFullscreen = true;
      } else {
        // Exit fullscreen
        if (document.exitFullscreen) {
          document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        } else if (document.msExitFullscreen) {
          document.msExitFullscreen();
        }
        backLink.classList.remove('fullscreen-hide');
        filterHint.classList.remove('fullscreen-hide');
        fullscreenBtn.classList.remove('fullscreen-hide');

        // Time and weather stay at top (already at 10px)

        isFullscreen = false;
      }
    }

    document.getElementById('fullscreen-btn').addEventListener('click', toggleFullscreen);

    // Handle browser fullscreen exit (e.g., pressing Escape)
    document.addEventListener('fullscreenchange', function() {
      if (!document.fullscreenElement) {
        const backLink = document.getElementById('back-link');
        const filterHint = document.getElementById('filter-hint');
        const fullscreenBtn = document.getElementById('fullscreen-btn');

        backLink.classList.remove('fullscreen-hide');
        filterHint.classList.remove('fullscreen-hide');
        fullscreenBtn.classList.remove('fullscreen-hide');

        // Time and weather stay at top (already at 10px)

        isFullscreen = false;
      }
    });

    const routeColors = {
      '1': { bg: '#EE352E', text: 'white' },
      '2': { bg: '#EE352E', text: 'white' },
      '3': { bg: '#EE352E', text: 'white' },
      '4': { bg: '#00933C', text: 'white' },
      '5': { bg: '#00933C', text: 'white' },
      '6': { bg: '#00933C', text: 'white' },
      '6X': { bg: '#00933C', text: 'white' },
      '7': { bg: '#B933AD', text: 'white' },
      '7X': { bg: '#B933AD', text: 'white' },
      'A': { bg: '#0039A6', text: 'white' },
      'C': { bg: '#0039A6', text: 'white' },
      'E': { bg: '#0039A6', text: 'white' },
      'B': { bg: '#FF6319', text: 'white' },
      'D': { bg: '#FF6319', text: 'white' },
      'F': { bg: '#FF6319', text: 'white' },
      'FX': { bg: '#FF6319', text: 'white' },
      'M': { bg: '#FF6319', text: 'white' },
      'G': { bg: '#6CBE45', text: 'white' },
      'J': { bg: '#996633', text: 'white' },
      'Z': { bg: '#996633', text: 'white' },
      'L': { bg: '#A7A9AC', text: 'white' },
      'N': { bg: '#FCCC0A', text: 'black' },
      'Q': { bg: '#FCCC0A', text: 'black' },
      'R': { bg: '#FCCC0A', text: 'black' },
      'W': { bg: '#FCCC0A', text: 'black' },
      'T': { bg: '#00ADD0', text: 'white' },
      'GS': { bg: '#808183', text: 'white' },
      'SI': { bg: '#0039A6', text: 'white' },
      'SIR': { bg: '#0039A6', text: 'white' },
      'FS': { bg: '#808183', text: 'white' },
      'H': { bg: '#808183', text: 'white' }
    };

    // Load available routes and create toggle buttons
    async function loadRoutes() {
      try {
        const resp = await fetch('/api/stations/' + stationId + '/routes');
        availableRoutes = await resp.json();

        const container = document.getElementById('route-toggles');
        if (availableRoutes.length === 0) {
          container.innerHTML = '<span style="color:#888;">No routes available</span>';
          return;
        }

        // Start with all routes selected
        selectedRoutes = new Set(availableRoutes);

        container.innerHTML = availableRoutes.map(route => {
          const colors = routeColors[route] || { bg: '#666', text: 'white' };
          return '<div class="route-toggle active" data-route="' + route + '" ' +
            'style="background-color: ' + colors.bg + '; color: ' + colors.text + ';">' +
            route + '</div>';
        }).join('');

        updateFilterHint();
      } catch (err) {
        console.error('Error loading routes:', err);
      }
    }

    function updateFilterHint() {
      const hint = document.getElementById('filter-hint');
      if (selectedRoutes.size === availableRoutes.length) {
        hint.innerText = 'Showing all routes - click to filter';
      } else if (selectedRoutes.size === 0) {
        hint.innerText = 'No routes selected - click routes to show';
      } else {
        hint.innerText = 'Filtered to ' + selectedRoutes.size + ' route(s)';
      }
    }

    // Track if user has started filtering
    let hasStartedFiltering = false;

    // Handle route toggle clicks
    document.getElementById('route-toggles').addEventListener('click', function(e) {
      const toggle = e.target.closest('.route-toggle');
      if (!toggle) return;

      const route = toggle.dataset.route;

      if (!hasStartedFiltering) {
        // First click: select ONLY this route, deselect all others
        selectedRoutes.clear();
        selectedRoutes.add(route);
        hasStartedFiltering = true;

        // Update all toggle buttons
        document.querySelectorAll('.route-toggle').forEach(btn => {
          if (btn.dataset.route === route) {
            btn.classList.add('active');
          } else {
            btn.classList.remove('active');
          }
        });
      } else {
        // Subsequent clicks: toggle individual routes
        if (selectedRoutes.has(route)) {
          selectedRoutes.delete(route);
          toggle.classList.remove('active');
        } else {
          selectedRoutes.add(route);
          toggle.classList.add('active');
        }

        // If no routes selected, reset to show all routes
        if (selectedRoutes.size === 0) {
          selectedRoutes = new Set(availableRoutes);
          hasStartedFiltering = false;
          document.querySelectorAll('.route-toggle').forEach(btn => {
            btn.classList.add('active');
          });
        }

        // If all routes selected again, reset filtering state
        if (selectedRoutes.size === availableRoutes.length) {
          hasStartedFiltering = false;
        }
      }

      updateFilterHint();
      fetchArrivals();
    });

    // Calculate how many rows fit on screen
    function calculateMaxRows() {
      const viewportHeight = window.innerHeight;
      const headerContainer = document.getElementById('header-container');
      const thead = document.querySelector('thead');
      const headerHeight = headerContainer ? headerContainer.offsetHeight : 150;
      const theadHeight = thead ? thead.offsetHeight : 50;
      const tableMargin = 40; // Table margin
      const rowHeight = 60; // Approximate row height

      const availableHeight = viewportHeight - headerHeight - theadHeight - tableMargin;
      const calculatedRows = Math.floor(availableHeight / rowHeight);

      // Clamp between 3 and 30 rows
      maxRows = Math.max(3, Math.min(30, calculatedRows));
      return maxRows;
    }

    // Create unique identifier for a train instance
    function getTrainId(entry, index) {
      // Use index to make each train unique
      return entry.line + '|' + entry.terminal + '|' + index;
    }

    // Check if a train should be highlighted based on tracked data
    function shouldBeHighlighted(entry, currentTime) {
      for (const [trainId, data] of highlightedTrains.entries()) {
        if (data.line === entry.line && data.terminal === entry.terminal) {
          // Calculate expected ETA based on time elapsed
          const minutesElapsed = Math.floor((currentTime - data.timestamp) / 60000);
          const expectedETA = Math.max(0, data.originalETA - minutesElapsed);

          // Allow 1 minute tolerance for matching
          if (Math.abs(entry.scheduled - expectedETA) <= 1) {
            return trainId;
          }
        }
      }
      return null;
    }

    // Render arrivals based on maxRows
    function renderArrivals() {
      const tbody = document.getElementById('arrival-table-body');
      tbody.innerHTML = '';

      if (cachedArrivals.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="color: #888;">No upcoming arrivals</td></tr>';
        return;
      }

      const currentTime = Date.now();

      // Clean up highlights for trains that no longer match
      const stillValid = new Map();

      // Slice to maxRows
      const displayData = cachedArrivals.slice(0, maxRows);

      displayData.forEach((entry, index) => {
        const colorInfo = routeColors[entry.line] || { bg: '#FFFFFF', text: 'black' };
        const isArrivingNow = entry.scheduled === 0;
        const row = document.createElement('tr');
        const trainId = getTrainId(entry, index);

        // Store train ID in row for click handling
        row.dataset.trainId = trainId;
        row.dataset.line = entry.line;
        row.dataset.terminal = entry.terminal;
        row.dataset.scheduled = entry.scheduled;

        // Check if this train should be highlighted
        const matchedId = shouldBeHighlighted(entry, currentTime);
        if (matchedId) {
          row.classList.add('highlighted');
          // Keep this highlight active
          stillValid.set(matchedId, highlightedTrains.get(matchedId));
        }

        const routeCell = document.createElement('td');
        // Border is black when arriving now, otherwise based on text color
        const borderColor = isArrivingNow ? 'black' : (colorInfo.text === 'black' ? 'black' : 'white');
        routeCell.innerHTML = '<span class="table-route-bullet" style="background-color: ' + colorInfo.bg + '; color: ' + colorInfo.text + '; border-color: ' + borderColor + ';">' + entry.line + '</span>';
        // Route cell keeps white background when arriving now but preserves the bullet color
        routeCell.style.backgroundColor = isArrivingNow ? 'white' : colorInfo.bg;

        const destCell = document.createElement('td');
        destCell.textContent = entry.terminal;

        const etaCell = document.createElement('td');
        etaCell.textContent = entry.scheduled;

        const statusCell = document.createElement('td');
        statusCell.textContent = entry.status;

        [destCell, etaCell, statusCell].forEach(cell => {
          if (isArrivingNow) {
            cell.style.backgroundColor = 'white';
            cell.style.color = 'black';
          } else {
            cell.style.backgroundColor = colorInfo.bg;
            cell.style.color = colorInfo.text;
          }
        });

        row.append(routeCell, destCell, etaCell, statusCell);
        tbody.appendChild(row);
      });

      // Update highlightedTrains to only include trains still visible
      highlightedTrains = stillValid;
    }

    async function fetchArrivals() {
      try {
        let url = '/api/stations/' + stationId + '/arrivals';

        // Add route filter if not showing all
        if (selectedRoutes.size > 0 && selectedRoutes.size < availableRoutes.length) {
          url += '?routes=' + Array.from(selectedRoutes).join(',');
        }

        const resp = await fetch(url);
        const json = await resp.json();

        document.getElementById('loading').style.display = 'none';
        document.getElementById('station-header').innerText = json.stationName || stationId;
        document.title = (json.stationName || stationId) + ' - Arrivals';

        // Filter client-side if no routes selected
        if (selectedRoutes.size === 0) {
          cachedArrivals = [];
        } else {
          cachedArrivals = json.data || [];
        }

        calculateMaxRows();
        renderArrivals();
      } catch (err) {
        console.error('Error fetching arrivals:', err);
        document.getElementById('loading').innerText = 'Error loading arrivals';
      }
    }

    // Debounce helper
    function debounce(fn, delay) {
      let timer;
      return function() {
        clearTimeout(timer);
        timer = setTimeout(fn, delay);
      };
    }

    // Recalculate on resize/orientation change
    const handleResize = debounce(function() {
      calculateMaxRows();
      renderArrivals();
    }, 200);

    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);

    // Handle clicking on train rows to highlight them
    document.getElementById('arrival-table-body').addEventListener('click', function(e) {
      const row = e.target.closest('tr');
      if (row && row.parentElement.id === 'arrival-table-body' && row.dataset.trainId) {
        const trainId = row.dataset.trainId;
        const line = row.dataset.line;
        const terminal = row.dataset.terminal;
        const scheduled = parseInt(row.dataset.scheduled);

        if (row.classList.contains('highlighted')) {
          // Remove highlight - find and delete the matching entry
          for (const [id, data] of highlightedTrains.entries()) {
            if (data.line === line && data.terminal === terminal) {
              const minutesElapsed = Math.floor((Date.now() - data.timestamp) / 60000);
              const expectedETA = Math.max(0, data.originalETA - minutesElapsed);
              if (Math.abs(scheduled - expectedETA) <= 1) {
                highlightedTrains.delete(id);
                break;
              }
            }
          }
          row.classList.remove('highlighted');
        } else {
          // Add highlight with tracking data
          highlightedTrains.set(trainId, {
            line: line,
            terminal: terminal,
            originalETA: scheduled,
            timestamp: Date.now()
          });
          row.classList.add('highlighted');
        }
      }
    });

    // Load routes first, then fetch arrivals
    loadRoutes().then(() => {
      calculateMaxRows();
      fetchArrivals();
      setInterval(fetchArrivals, 30000);
    });
  </script>
</body>
</html>
  `);
});

// Start the server
const port = process.env.PORT || 5000;
app.listen(port, '0.0.0.0', () => {
  console.log('Server running on port', port);
});
