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
    data: arrivalsWithStatus.slice(0, 14).map(entry => ({
      line: entry.route_id,
      stop: entry.current_stop,
      terminal: entry.last_stop_name,
      scheduled: entry.arrival_time,
      status: entry.service_status
    }))
  };

  res.json(result);
});

// Station display page - redirect to display.html with station parameter
app.get('/station/:stationId', (req, res) => {
  const { stationId } = req.params;
  res.redirect(`/display.html?station=${stationId}`);
});

// Split-flap display page (serves display.html)
app.get('/display.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

// Static files
app.use('/', express.static('public'));

const port = process.env.PORT || 5000;
app.listen(port, '0.0.0.0', () => {
  console.log('split flap started on 0.0.0.0:' + port);
});
