const fs = require('fs');
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());

// Use SubwayDisplay's stations.csv as the primary source
const stationsFilePath = path.join(__dirname, 'SubwayDisplay', 'stations.csv');

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
        id: s.parent_id,
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

// API: Get arrivals for station - Support both apps' needs
app.get('/api/stations/:stationId/arrivals', async (req, res) => {
  const { stationId } = req.params;
  const routeFilter = req.query.routes ? req.query.routes.split(',') : null;
  const maxResults = parseInt(req.query.max) || 30;

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
    data: arrivalsWithStatus.slice(0, maxResults).map(entry => ({
      line: entry.route_id,
      stop: entry.current_stop,
      terminal: entry.last_stop_name,
      scheduled: entry.arrival_time,
      status: entry.service_status
    }))
  };

  res.json(result);
});

// === LANDING PAGE ===
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>NYC Subway Display Hub</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
    }
    .container {
      max-width: 1200px;
      width: 100%;
      padding: 40px;
      text-align: center;
    }
    h1 {
      font-size: 3.5em;
      margin: 0 0 20px 0;
      text-shadow: 2px 2px 8px rgba(0,0,0,0.5);
      letter-spacing: 2px;
    }
    .subtitle {
      color: #aaa;
      margin-bottom: 60px;
      font-size: 1.3em;
      font-weight: 300;
    }
    .apps-container {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
      gap: 40px;
      margin-top: 40px;
    }
    .app-card {
      background: rgba(255, 255, 255, 0.05);
      border-radius: 20px;
      padding: 50px 40px;
      transition: all 0.3s ease;
      cursor: pointer;
      border: 2px solid rgba(255, 255, 255, 0.1);
      text-decoration: none;
      color: white;
      display: block;
    }
    .app-card:hover {
      transform: translateY(-10px);
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.3);
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
    }
    .app-icon {
      font-size: 4em;
      margin-bottom: 20px;
    }
    .app-title {
      font-size: 2em;
      font-weight: bold;
      margin-bottom: 15px;
      letter-spacing: 1px;
    }
    .app-description {
      color: #bbb;
      font-size: 1.1em;
      line-height: 1.6;
    }
    .feature-list {
      margin-top: 20px;
      text-align: left;
      display: inline-block;
    }
    .feature-item {
      color: #ddd;
      margin: 8px 0;
      font-size: 0.95em;
    }
    .feature-item:before {
      content: "✓ ";
      color: #4a90d9;
      font-weight: bold;
      margin-right: 8px;
    }
    @media (max-width: 768px) {
      .apps-container {
        grid-template-columns: 1fr;
        gap: 30px;
      }
      h1 {
        font-size: 2.5em;
      }
      .app-card {
        padding: 40px 30px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>NYC SUBWAY DISPLAY HUB</h1>
    <p class="subtitle">Choose your preferred display mode for real-time train arrivals</p>
    
    <div class="apps-container">
      <a href="/display" class="app-card">
        <div class="app-icon">📊</div>
        <div class="app-title">SubwayDisplay</div>
        <div class="app-description">
          Modern table-based arrivals display with advanced features
        </div>
        <div class="feature-list">
          <div class="feature-item">Route filtering & selection</div>
          <div class="feature-item">Train highlighting & tracking</div>
          <div class="feature-item">Weather integration</div>
          <div class="feature-item">Fullscreen mode</div>
          <div class="feature-item">Dynamic sizing</div>
        </div>
      </a>
      
      <a href="/solari" class="app-card">
        <div class="app-icon">🎰</div>
        <div class="app-title">SubwaySolari</div>
        <div class="app-description">
          Classic split-flap display board with authentic animations
        </div>
        <div class="feature-list">
          <div class="feature-item">Vintage split-flap animation</div>
          <div class="feature-item">Authentic flip sounds</div>
          <div class="feature-item">14-row display board</div>
          <div class="feature-item">Route badges</div>
          <div class="feature-item">Status indicators</div>
        </div>
      </a>

      <a href="/stripmap" class="app-card">
        <div class="app-icon">🚇</div>
        <div class="app-title">Strip Map View</div>
        <div class="app-description">
          Visual timeline display with horizontal route tracking
        </div>
        <div class="feature-list">
          <div class="feature-item">Timeline-style visualization</div>
          <div class="feature-item">Per-route arrival tracking</div>
          <div class="feature-item">Next train highlighting</div>
          <div class="feature-item">Destination labels</div>
          <div class="feature-item">Service status indicators</div>
        </div>
      </a>
    </div>
  </div>
</body>
</html>
  `);
});

// === SUBDISPLAY ROUTES ===
// Station selector for SubwayDisplay
app.get('/display', (req, res) => {
  res.sendFile(path.join(__dirname, 'SubwayDisplay', 'public', 'index.html'));
});

// Station arrivals page for SubwayDisplay
app.get('/display/station/:stationId', (req, res) => {
  const { stationId } = req.params;
  res.sendFile(path.join(__dirname, 'display-station.html'));
});

// === SOLARI ROUTES ===
// Station selector for Solari
app.get('/solari', (req, res) => {
  res.sendFile(path.join(__dirname, 'Subway-Split-Flap-Solari-v15', 'public', 'index.html'));
});

// Station display for Solari
app.get('/solari/station/:stationId', (req, res) => {
  res.redirect(`/solari/display.html?station=${req.params.stationId}`);
});

// Solari display.html
app.get('/solari/display.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'Subway-Split-Flap-Solari-v15', 'public', 'display.html'));
});

// === STRIPMAP ROUTES ===
// Station selector for Strip Map
app.get('/stripmap', (req, res) => {
  res.sendFile(path.join(__dirname, 'StripMap', 'public', 'index.html'));
});

// Station display for Strip Map
app.get('/stripmap/station/:stationId', (req, res) => {
  res.sendFile(path.join(__dirname, 'stripmap-station.html'));
});

// === STATIC FILES ===
// Serve SubwayDisplay static files
app.use('/display', express.static(path.join(__dirname, 'SubwayDisplay', 'public')));

// Serve Solari static files
app.use('/solari', express.static(path.join(__dirname, 'Subway-Split-Flap-Solari-v15', 'public')));

// Serve StripMap static files
app.use('/stripmap', express.static(path.join(__dirname, 'StripMap', 'public')));

// Start the server
const port = process.env.PORT || 5001;
app.listen(port, '0.0.0.0', () => {
  console.log(`🚇 NYC Subway Display Hub running on port ${port}`);
  console.log(`   Landing page: http://localhost:${port}`);
  console.log(`   SubwayDisplay: http://localhost:${port}/display`);
  console.log(`   SubwaySolari: http://localhost:${port}/solari`);
  console.log(`   Strip Map View: http://localhost:${port}/stripmap`);
});
