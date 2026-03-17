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

// === FERRY CONFIGURATION ===
const FERRY_API_KEY = 'a7dFdSvEVIq7QYZJ4tgatsEFD6C8hXWu';
const FERRY_CACHE_TTL = 30000; // 30 seconds
const ferryDeparturesCache = {};

// Ferry stop name lookup
const ferryStopNames = {
  "s-dr5rubz42m-hunterspointsouth": "Hunters Point South",
  "s-dr5rsfb98g-southwilliamsburg": "South Williamsburg",
  "s-dr5rkpc3ft-atlanticave~bbppier6": "Atlantic Ave/BBP Pier 6",
  "s-dr5qzuj6j9-beachchanneldr~beach108thstreet": "Beach Channel Dr/Beach 108th Street",
  "s-dr5ruc0nmp-east34thstreet": "East 34th Street",
  "s-dr5rsyvm6u-greenpoint": "Greenpoint",
  "s-dr5rsvh2hf-northwilliamsburg": "North Williamsburg",
  "s-dr5rs1vgzy-dumbo~fultonferry": "Dumbo/Fulton Ferry",
  "s-dr5r5nr06d-bayridge": "Bay Ridge",
  "s-dr5r7v9pgb-redhook~atlanticbasin": "Red Hook/Atlantic Basin",
  "s-dr5rv5t3wk-rooseveltisland": "Roosevelt Island",
  "s-dr5wbyp7vb-beachchanneldr~beach54thstreet": "Beach Channel Dr/Beach 54th Street",
  "s-dr5wbku24f-rockawaybeachboulevard~beach86thstreet": "Rockaway Beach Blvd & Beach 86th St",
  "s-dr5wcq0rrq-beachchanneldr~beach41ststreet": "Beach Channel Dr/Beach 41st Street",
  "s-dr5qyc027j-rockawaypointboulevard~beach169thstreet": "Rockaway Point Blvd & Beach 169th St",
  "s-dr5qybzdyx-jacobriisparkroad~bathhouse": "Jacob Riis Park Road/Bath House",
  "s-dr5qz1qn5q-rockawaybeachboulevard~beach149thstreet": "Rockaway Beach Blvd & Beach 149th St",
  "s-dr5qz6mbp7-rockawaybeachboulevard~beach135thstreet": "Rockaway Beach Blvd & Beach 135th St",
  "s-dr5qzdg0cb-rockawaybeachboulevard~beach127thstreet": "Rockaway Beach Blvd & Beach 127th St",
  "s-dr5qzepyvw-rockawaybeachboulevard~beach118thstreet": "Rockaway Beach Blvd & Beach 118th St",
  "s-dr5wcq6fq2-beachchanneldr~beach36thstreet": "Beach Channel Dr/Beach 36th Street",
  "s-dr5recy35g-wallst~pier11": "Wall St/Pier 11",
  "s-dr5qzujkr0-rockaway": "Rockaway",
  "s-dr5rvw38kz-astoria": "Astoria",
  "s-dr5rv418u0-longislandcity": "Long Island City",
  "s-dr5wbtr1vm-rockawaybeachboulevard~beach67thstreet": "Rockaway Beach Blvd & Beach 67th St",
  "s-dr5wbhr7hu-rockawaybeachboulevard~beach96thstreet": "Rockaway Beach Blvd & Beach 96th St",
  "s-dr5wbsch36-rockawaybeachboulevard~beach77thstreet": "Rockaway Beach Blvd & Beach 77th St",
  "s-dr5r7wybfg-govisland~yankeepier": "Gov. Island/Yankee Pier",
  "s-dr72ps1j8q-soundview": "Soundview",
  "s-dr5rvrkfn8-east90thst": "East 90th St",
  "s-dr5rsxn8cz-stuyvesantcove": "Stuyvesant Cove",
  "s-dr5rse1cye-corlearshook": "Corlears Hook",
  "s-dr5r5rrtep-sunsetpark~bat": "Sunset Park/BAT",
  "s-dr5rs9w14e-brooklynnavyyard": "Brooklyn Navy Yard",
  "s-dr5reevyhz-batteryparkcity~veseyst": "Battery Park City/Vesey St.",
  "s-dr5r4rku92-stgeorge": "St. George",
  "s-dr5rgupyh4-midtownwest~w39thst~pier79": "Midtown West/W 39th St-Pier 79",
  "s-dr72pu3m40-ferrypointpark": "Ferry Point Park",
  "s-dr5wbh53by-rockawaybeachboulevard~beach102ndstreet": "Rockaway Beach Blvd & Beach 102nd St",
  "s-dr5wbsbe5e-rockawaybeachboulevard~beach79thstreet": "Rockaway Beach Blvd & Beach 79th St"
};

// Fetch ferry departures from Transit.land API
async function fetchFerryDepartures(stopCode) {
  const now = Date.now();

  // Check cache
  if (ferryDeparturesCache[stopCode] && (now - ferryDeparturesCache[stopCode].timestamp) < FERRY_CACHE_TTL) {
    return ferryDeparturesCache[stopCode].data;
  }

  try {
    const fetch = (await import('node-fetch')).default;
    const url = `https://transit.land/api/v2/rest/stops/${stopCode}/departures?apikey=${FERRY_API_KEY}&relative_date=today&next=28800`;
    const resp = await fetch(url);
    const data = await resp.json();

    const departures = [];
    const stopName = ferryStopNames[stopCode] || stopCode;

    if (data.stops && data.stops.length > 0) {
      const stop = data.stops[0];
      for (const dep of (stop.departures || [])) {
        const departureScheduled = dep.departure?.scheduled_local || dep.departure?.scheduled || dep.departure_time;
        if (!departureScheduled) continue;

        // Parse the departure time
        let departureDate;
        if (dep.departure?.scheduled_local) {
          departureDate = new Date(dep.departure.scheduled_local);
        } else {
          // Time-only format like "13:37:00" - construct full datetime
          const timeParts = departureScheduled.split(':');
          departureDate = new Date();
          departureDate.setHours(parseInt(timeParts[0]), parseInt(timeParts[1]), parseInt(timeParts[2] || 0), 0);
        }

        const etaMs = departureDate.getTime() - now;
        const etaMinutes = Math.floor(etaMs / 60000);

        // Only include future departures
        if (etaMinutes < -1) continue;

        const trip = dep.trip || {};
        const route = trip.route || {};

        // Format departure time for display (12-hour format)
        let displayHours = departureDate.getHours();
        const displayMinutes = departureDate.getMinutes();
        const ampm = displayHours >= 12 ? 'PM' : 'AM';
        displayHours = displayHours % 12 || 12;
        const displayTime = displayHours + ':' + (displayMinutes < 10 ? '0' : '') + displayMinutes + ' ' + ampm;

        departures.push({
          route_short: route.route_short_name || route.route_id || 'FRY',
          route_name: route.route_long_name || route.route_short_name || 'NYC Ferry',
          route_color: route.route_color || '0077b6',
          route_text_color: route.route_text_color || 'FFFFFF',
          headsign: trip.trip_headsign || 'Unknown',
          departure_time_display: displayTime,
          eta_minutes: Math.max(0, etaMinutes)
        });
      }
    }

    // Sort by ETA
    departures.sort((a, b) => a.eta_minutes - b.eta_minutes);

    const result = { stopName, departures };

    // Cache results
    ferryDeparturesCache[stopCode] = {
      data: result,
      timestamp: now
    };

    return result;
  } catch (err) {
    console.error(`Error fetching ferry departures for ${stopCode}:`, err);
    return { stopName: ferryStopNames[stopCode] || stopCode, departures: [] };
  }
}

// === CITIBIKE CONFIGURATION ===
const CITIBIKE_INFO_URL = 'https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_information.json';
const CITIBIKE_STATUS_URL = 'https://gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json';
const CITIBIKE_CACHE_TTL = 60000; // 60 seconds
let citibikeCache = { data: null, timestamp: 0 };

// Fetch and merge CitiBike station info + status
async function fetchCitibikeData() {
  const now = Date.now();
  if (citibikeCache.data && (now - citibikeCache.timestamp) < CITIBIKE_CACHE_TTL) {
    return citibikeCache.data;
  }

  try {
    const fetch = (await import('node-fetch')).default;
    const [infoResp, statusResp] = await Promise.all([
      fetch(CITIBIKE_INFO_URL),
      fetch(CITIBIKE_STATUS_URL)
    ]);
    const infoData = await infoResp.json();
    const statusData = await statusResp.json();

    // Build status map by station_id
    const statusMap = {};
    for (const s of statusData.data.stations) {
      statusMap[s.station_id] = s;
    }

    // Merge info + status, only include installed & renting stations with capacity
    const merged = [];
    for (const info of infoData.data.stations) {
      const status = statusMap[info.station_id];
      if (!status) continue;

      // Parse vehicle types for classic vs e-bike
      let classicBikes = 0, ebikes = 0;
      if (status.vehicle_types_available) {
        for (const vt of status.vehicle_types_available) {
          if (vt.vehicle_type_id === '1') classicBikes = vt.count;
          else if (vt.vehicle_type_id === '2') ebikes = vt.count;
        }
      }

      merged.push({
        station_id: info.station_id,
        name: info.name,
        lat: info.lat,
        lon: info.lon,
        capacity: info.capacity,
        region_id: info.region_id,
        num_bikes_available: status.num_bikes_available || 0,
        num_docks_available: status.num_docks_available || 0,
        num_ebikes_available: status.num_ebikes_available || 0,
        num_bikes_disabled: status.num_bikes_disabled || 0,
        num_docks_disabled: status.num_docks_disabled || 0,
        classic_bikes: classicBikes,
        ebikes: ebikes,
        is_installed: status.is_installed,
        is_renting: status.is_renting,
        is_returning: status.is_returning,
        last_reported: status.last_reported
      });
    }

    // Sort by name
    merged.sort((a, b) => a.name.localeCompare(b.name));

    citibikeCache = { data: merged, timestamp: now };
    return merged;
  } catch (err) {
    console.error('Error fetching CitiBike data:', err);
    return citibikeCache.data || [];
  }
}

// Haversine distance (km)
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
      display: flex;
      justify-content: center;
      gap: 30px;
      margin-top: 40px;
      flex-wrap: wrap;
    }
    .app-card {
      background: rgba(255, 255, 255, 0.05);
      border-radius: 20px;
      padding: 40px 30px;
      transition: all 0.3s ease;
      cursor: pointer;
      border: 2px solid rgba(255, 255, 255, 0.1);
      text-decoration: none;
      color: white;
      display: block;
      flex: 1;
      min-width: 300px;
      max-width: 380px;
    }
    .app-card:hover {
      transform: translateY(-10px);
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.3);
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
    }
    .app-icon {
      margin-bottom: 20px;
      height: 120px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .app-icon img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      border-radius: 10px;
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
    <h1>NYC TRANSIT DISPLAY HUB</h1>
    <p class="subtitle">Choose your preferred display mode for real-time transit departures</p>
    
    <div class="apps-container">
      <a href="/display" class="app-card">
        <div class="app-icon"><img src="/images/Modern.png" alt="SubwayDisplay"></div>
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
        <div class="app-icon"><img src="/images/Solari.png" alt="SubwaySolari"></div>
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
        <div class="app-icon"><img src="/images/Stripmap.png" alt="Strip Map View"></div>
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

      <a href="/ferry" class="app-card" style="border-color: rgba(0, 119, 182, 0.3);">
        <div class="app-icon"><img src="/images/NYC_Ferry_Horizontal.png" alt="NYC Ferry"></div>
        <div class="app-title">NYC Ferry</div>
        <div class="app-description">
          Real-time NYC Ferry departure board for all waterway routes
        </div>
        <div class="feature-list">
          <div class="feature-item">40+ ferry stops across NYC</div>
          <div class="feature-item">Real-time departure times</div>
          <div class="feature-item">Route filtering by ferry line</div>
          <div class="feature-item">ETA countdown display</div>
          <div class="feature-item">Weather & fullscreen mode</div>
        </div>
      </a>

      <a href="/citibike" class="app-card" style="border-color: rgba(0, 115, 207, 0.3);">
        <div class="app-icon"><img src="/images/citi-bike.png" alt="Citi Bike"></div>
        <div class="app-title">Citi Bike</div>
        <div class="app-description">
          Real-time Citi Bike dock availability across all NYC stations
        </div>
        <div class="feature-list">
          <div class="feature-item">2,300+ bike stations</div>
          <div class="feature-item">Classic & e-bike counts</div>
          <div class="feature-item">Dock availability gauge</div>
          <div class="feature-item">Nearby stations</div>
          <div class="feature-item">Auto-refresh every 30s</div>
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

// === FERRY ROUTES ===
// Ferry API: Get departures for a ferry stop
app.get('/api/ferry/stops/:stopCode/departures', async (req, res) => {
  const stopCode = decodeURIComponent(req.params.stopCode);
  const data = await fetchFerryDepartures(stopCode);
  res.json(data);
});

// Ferry stop selector page
app.get('/ferry', (req, res) => {
  res.sendFile(path.join(__dirname, 'ferry-index.html'));
});

// Ferry departure display page
app.get('/ferry/stop/:stopCode', (req, res) => {
  res.sendFile(path.join(__dirname, 'ferry-station.html'));
});

// === CITIBIKE ROUTES ===
// CitiBike API: Get all stations with status (supports ?lat=&lon=&limit= for nearby)
app.get('/api/citibike/stations', async (req, res) => {
  let data = await fetchCitibikeData();
  // Filter to only active stations for the list
  data = data.filter(s => s.is_installed && s.is_renting);

  // If lat/lon provided, sort by distance
  if (req.query.lat && req.query.lon) {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    const limit = parseInt(req.query.limit) || 10;
    data = data.map(s => ({ ...s, _dist: haversineKm(lat, lon, s.lat, s.lon) }));
    data.sort((a, b) => a._dist - b._dist);
    data = data.slice(0, limit);
    data.forEach(s => delete s._dist);
  }

  res.json(data);
});

// CitiBike API: Get single station detail
app.get('/api/citibike/stations/:stationId', async (req, res) => {
  const allData = await fetchCitibikeData();
  const station = allData.find(s => s.station_id === req.params.stationId);
  if (!station) return res.status(404).json({ error: 'Station not found' });
  res.json(station);
});

// CitiBike station selector page
app.get('/citibike', (req, res) => {
  res.sendFile(path.join(__dirname, 'citibike-index.html'));
});

// CitiBike station detail page
app.get('/citibike/station/:stationId', (req, res) => {
  res.sendFile(path.join(__dirname, 'citibike-station.html'));
});

// === STATIC FILES ===
// Serve images from root directory
app.use('/images', express.static(__dirname));

// Serve SubwayDisplay static files
app.use('/display', express.static(path.join(__dirname, 'SubwayDisplay', 'public')));

// Serve Solari static files
app.use('/solari', express.static(path.join(__dirname, 'Subway-Split-Flap-Solari-v15', 'public')));

// Serve StripMap static files
app.use('/stripmap', express.static(path.join(__dirname, 'StripMap', 'public')));

// Start the server
const port = process.env.PORT || 5000;
app.listen(port, '0.0.0.0', () => {
  console.log(`🚇 NYC Transit Display Hub running on port ${port}`);
  console.log(`   Landing page: http://localhost:${port}`);
  console.log(`   SubwayDisplay: http://localhost:${port}/display`);
  console.log(`   SubwaySolari: http://localhost:${port}/solari`);
  console.log(`   Strip Map View: http://localhost:${port}/stripmap`);
  console.log(`   ⛴ NYC Ferry: http://localhost:${port}/ferry`);
  console.log(`   🚲 Citi Bike: http://localhost:${port}/citibike`);
});
