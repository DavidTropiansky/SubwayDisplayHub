'use strict';

/**
 * Live Map extension loader.
 *
 * The original app.js is intentionally left untouched. This file registers the
 * Live Map API/page on the same Express application, adds a discoverable card
 * to the existing landing page, and then starts the legacy application.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const fetch = require('node-fetch');

const TRANSITER_BASE = 'https://demo.transiter.dev/systems/us-ny-subway';
const LIVE_CACHE_TTL = 15000;
const MAX_CONCURRENT_ROUTE_REQUESTS = 6;

const routeColors = {
  '1': { bg: '#EE352E', text: '#FFFFFF' },
  '2': { bg: '#EE352E', text: '#FFFFFF' },
  '3': { bg: '#EE352E', text: '#FFFFFF' },
  '4': { bg: '#00933C', text: '#FFFFFF' },
  '5': { bg: '#00933C', text: '#FFFFFF' },
  '6': { bg: '#00933C', text: '#FFFFFF' },
  '6X': { bg: '#00933C', text: '#FFFFFF' },
  '7': { bg: '#B933AD', text: '#FFFFFF' },
  '7X': { bg: '#B933AD', text: '#FFFFFF' },
  'A': { bg: '#0039A6', text: '#FFFFFF' },
  'C': { bg: '#0039A6', text: '#FFFFFF' },
  'E': { bg: '#0039A6', text: '#FFFFFF' },
  'B': { bg: '#FF6319', text: '#FFFFFF' },
  'D': { bg: '#FF6319', text: '#FFFFFF' },
  'F': { bg: '#FF6319', text: '#FFFFFF' },
  'FX': { bg: '#FF6319', text: '#FFFFFF' },
  'M': { bg: '#FF6319', text: '#FFFFFF' },
  'G': { bg: '#6CBE45', text: '#FFFFFF' },
  'J': { bg: '#996633', text: '#FFFFFF' },
  'Z': { bg: '#996633', text: '#FFFFFF' },
  'L': { bg: '#A7A9AC', text: '#FFFFFF' },
  'N': { bg: '#FCCC0A', text: '#000000' },
  'Q': { bg: '#FCCC0A', text: '#000000' },
  'R': { bg: '#FCCC0A', text: '#000000' },
  'W': { bg: '#FCCC0A', text: '#000000' },
  'GS': { bg: '#808183', text: '#FFFFFF' },
  'FS': { bg: '#808183', text: '#FFFFFF' },
  'H': { bg: '#808183', text: '#FFFFFF' },
  'S': { bg: '#808183', text: '#FFFFFF' },
  'SI': { bg: '#0039A6', text: '#FFFFFF' }
};

const stationsFilePath = path.join(__dirname, 'SubwayDisplay', 'stations.csv');
const stationById = new Map();
const consolidatedStations = [];

function loadStations() {
  const raw = fs.readFileSync(stationsFilePath, 'utf8');
  const rows = raw.trim().split(/\r?\n/).slice(1);
  const grouped = new Map();

  for (const row of rows) {
    const parts = row.split(',');
    if (parts.length < 5) continue;

    const station = {
      id: parts[0].trim(),
      name: parts[1].trim(),
      lat: Number(parts[2]),
      lon: Number(parts[3]),
      parentId: parts[4].trim()
    };

    if (!station.id || !Number.isFinite(station.lat) || !Number.isFinite(station.lon)) continue;
    stationById.set(station.id, station);

    const groupKey = station.parentId || station.id;
    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, {
        id: groupKey,
        name: station.name,
        latTotal: 0,
        lonTotal: 0,
        count: 0
      });
    }
    const group = grouped.get(groupKey);
    group.latTotal += station.lat;
    group.lonTotal += station.lon;
    group.count += 1;
  }

  for (const group of grouped.values()) {
    consolidatedStations.push({
      id: group.id,
      name: group.name,
      lat: group.latTotal / group.count,
      lon: group.lonTotal / group.count
    });
  }
}

loadStations();

function getRouteStyle(routeId, route = {}) {
  const configured = routeColors[routeId];
  const rawColor = route.color || route.routeColor || route.route_color;
  const rawTextColor = route.textColor || route.text_color || route.routeTextColor;

  return {
    color: configured?.bg || (rawColor ? `#${String(rawColor).replace('#', '')}` : '#64748B'),
    textColor: configured?.text || (rawTextColor ? `#${String(rawTextColor).replace('#', '')}` : '#FFFFFF')
  };
}

function normalizeStopId(rawStopId) {
  const id = String(rawStopId || '').trim();
  if (!id) return '';
  if (stationById.has(id)) return id;

  const withoutDirection = id.replace(/[NS]$/, '');
  if (stationById.has(withoutDirection)) return withoutDirection;

  return id;
}

function getStationForStop(stopRef = {}) {
  const rawId = stopRef.id || stopRef.stopId || stopRef.stop_id || '';
  const normalizedId = normalizeStopId(rawId);
  const direct = stationById.get(normalizedId);
  if (direct) return direct;

  const parentRef = stopRef.parentStop || stopRef.parent_stop;
  const parentId = normalizeStopId(parentRef?.id || '');
  return stationById.get(parentId) || null;
}

function getEstimatedTime(stopTime) {
  const arrival = stopTime.arrival?.time;
  const departure = stopTime.departure?.time;
  const value = arrival ?? departure;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getStopTimes(trip) {
  const stopTimes = trip.stopTimes || trip.stop_times || [];
  return stopTimes
    .map((stopTime, index) => {
      const stopRef = stopTime.stop || {};
      const station = getStationForStop(stopRef);
      const rawStopId = String(stopRef.id || stopRef.stopId || stopRef.stop_id || '');
      return {
        rawStopId,
        id: station?.id || normalizeStopId(rawStopId),
        name: stopRef.name || station?.name || rawStopId || 'Unknown station',
        lat: station?.lat ?? null,
        lon: station?.lon ?? null,
        time: getEstimatedTime(stopTime),
        future: stopTime.future !== false,
        sequence: Number(stopTime.stopSequence ?? stopTime.stop_sequence ?? index)
      };
    })
    .filter(stop => stop.id)
    .sort((a, b) => a.sequence - b.sequence);
}

function dedupeConsecutiveStops(stops) {
  const result = [];
  for (const stop of stops) {
    if (result[result.length - 1]?.id === stop.id) continue;
    result.push(stop);
  }
  return result;
}

function inferDirection(trip, stops) {
  const directionalIds = stops
    .map(stop => stop.rawStopId.match(/[NS]$/)?.[0])
    .filter(Boolean);

  if (directionalIds.length) {
    const northCount = directionalIds.filter(value => value === 'N').length;
    const southCount = directionalIds.length - northCount;
    return northCount >= southCount ? 'N' : 'S';
  }

  const directionId = trip.directionId ?? trip.direction_id;
  return directionId === true || directionId === 1 || directionId === '1' ? '1' : '0';
}

function directionMeta(direction) {
  if (direction === 'N') {
    return { label: 'Northbound / Eastbound', arrow: '↗' };
  }
  if (direction === 'S') {
    return { label: 'Southbound / Westbound', arrow: '↙' };
  }
  if (direction === '1') {
    return { label: 'Direction 2', arrow: '→' };
  }
  return { label: 'Direction 1', arrow: '←' };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'SubwayDisplayHub/1.0 LiveMap'
    },
    timeout: 12000
  });

  if (!response.ok) {
    throw new Error(`Transiter returned ${response.status} for ${url}`);
  }

  return response.json();
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

let liveMapCache = {
  timestamp: 0,
  data: null,
  pending: null
};

async function buildLiveMapData() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const routesReply = await fetchJson(
    `${TRANSITER_BASE}/routes?skip_estimated_headways=true&skip_service_maps=true&skip_alerts=true`
  );

  const routeResources = (routesReply.routes || [])
    .map(route => ({
      raw: route,
      id: String(route.id || route.shortName || route.short_name || '').trim()
    }))
    .filter(route => route.id && /^[A-Z0-9]+$/i.test(route.id));

  const routeReplies = await mapWithConcurrency(
    routeResources,
    MAX_CONCURRENT_ROUTE_REQUESTS,
    async route => {
      try {
        const reply = await fetchJson(
          `${TRANSITER_BASE}/routes/${encodeURIComponent(route.id)}/trips`
        );
        return { ...route, trips: reply.trips || [], error: null };
      } catch (error) {
        console.error(`Live Map route fetch failed for ${route.id}:`, error.message);
        return { ...route, trips: [], error: error.message };
      }
    }
  );

  const routes = [];
  const trains = [];
  const patterns = {};
  const warnings = [];

  for (const routeReply of routeReplies) {
    const routeId = routeReply.id;
    const style = getRouteStyle(routeId, routeReply.raw);
    routes.push({
      id: routeId,
      name: routeReply.raw.longName || routeReply.raw.long_name || routeReply.raw.shortName || routeId,
      color: style.color,
      textColor: style.textColor
    });

    if (routeReply.error) {
      warnings.push(`${routeId}: ${routeReply.error}`);
      continue;
    }

    const bestPatterns = {};

    for (const trip of routeReply.trips) {
      const allStops = dedupeConsecutiveStops(getStopTimes(trip));
      if (!allStops.length) continue;

      const direction = inferDirection(trip, allStops);
      const meta = directionMeta(direction);
      const usablePatternStops = allStops.filter(
        stop => Number.isFinite(stop.lat) && Number.isFinite(stop.lon)
      );

      if (
        usablePatternStops.length > 1 &&
        (!bestPatterns[direction] || usablePatternStops.length > bestPatterns[direction].stations.length)
      ) {
        bestPatterns[direction] = {
          direction,
          directionLabel: meta.label,
          arrow: meta.arrow,
          destination: allStops[allStops.length - 1]?.name || 'Unknown destination',
          stations: usablePatternStops.map(stop => ({
            id: stop.id,
            name: stop.name,
            lat: stop.lat,
            lon: stop.lon
          }))
        };
      }

      const currentCandidates = allStops
        .filter(stop => {
          if (!stop.future || stop.time === null) return false;
          const etaSeconds = stop.time - nowSeconds;
          return etaSeconds >= 0 && etaSeconds < 60;
        })
        .sort((a, b) => a.time - b.time);

      const currentStop = currentCandidates[0];
      if (!currentStop || !Number.isFinite(currentStop.lat) || !Number.isFinite(currentStop.lon)) {
        continue;
      }

      const currentIndex = allStops.findIndex(stop => stop.id === currentStop.id);
      const destination = allStops[allStops.length - 1] || currentStop;
      const tripId = String(trip.id || trip.tripId || trip.trip_id || `${routeId}-${currentStop.id}-${currentStop.time}`);

      trains.push({
        id: tripId,
        routeId,
        routeName: routeReply.raw.longName || routeReply.raw.long_name || routeId,
        color: style.color,
        textColor: style.textColor,
        direction,
        directionLabel: meta.label,
        directionArrow: meta.arrow,
        stationId: currentStop.id,
        stationName: currentStop.name,
        lat: currentStop.lat,
        lon: currentStop.lon,
        destination: destination.name,
        etaSeconds: Math.max(0, currentStop.time - nowSeconds),
        stopIndex: currentIndex,
        stopCount: allStops.length,
        vehicleId: trip.vehicle?.id || null
      });
    }

    patterns[routeId] = bestPatterns;
  }

  routes.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  trains.sort((a, b) => {
    const routeCompare = a.routeId.localeCompare(b.routeId, undefined, { numeric: true });
    return routeCompare || a.stationName.localeCompare(b.stationName);
  });

  return {
    generatedAt: new Date().toISOString(),
    refreshSeconds: Math.round(LIVE_CACHE_TTL / 1000),
    definition: 'A train is displayed when its next/current stop ETA is between 0 and 59 seconds, matching an arrival time of 0 minutes.',
    routes,
    stations: consolidatedStations,
    patterns,
    trains,
    warnings
  };
}

async function getLiveMapData(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && liveMapCache.data && now - liveMapCache.timestamp < LIVE_CACHE_TTL) {
    return liveMapCache.data;
  }

  if (liveMapCache.pending) return liveMapCache.pending;

  liveMapCache.pending = buildLiveMapData()
    .then(data => {
      liveMapCache = {
        timestamp: Date.now(),
        data,
        pending: null
      };
      return data;
    })
    .catch(error => {
      liveMapCache.pending = null;
      throw error;
    });

  return liveMapCache.pending;
}

function installLiveMapRoutes(app) {
  if (app.locals.liveMapInstalled) return;
  app.locals.liveMapInstalled = true;

  app.get('/api/live-map', async (req, res) => {
    try {
      const data = await getLiveMapData(req.query.refresh === '1');
      res.set('Cache-Control', 'no-store');
      res.json(data);
    } catch (error) {
      console.error('Live Map API failed:', error);
      res.status(502).json({
        error: 'Unable to load live subway positions right now.',
        detail: error.message
      });
    }
  });

  app.get(['/live-map', '/livemap'], (req, res) => {
    res.sendFile(path.join(__dirname, 'live-map.html'));
  });
}

function liveMapCardHtml() {
  return `
      <a href="/live-map" class="app-card" style="border-color: rgba(252, 204, 10, 0.45);">
        <div class="app-icon" aria-hidden="true">
          <svg width="128" height="112" viewBox="0 0 128 112" role="img">
            <path d="M18 92 C34 72 38 48 58 39 C78 30 79 15 111 17" fill="none" stroke="#8a96a8" stroke-width="7" stroke-linecap="round"/>
            <path d="M17 78 C40 73 47 82 64 69 C80 57 91 63 112 46" fill="none" stroke="#FCCC0A" stroke-width="6" stroke-linecap="round"/>
            <circle cx="18" cy="92" r="7" fill="#EE352E"/>
            <circle cx="44" cy="61" r="7" fill="#0039A6"/>
            <circle cx="64" cy="69" r="7" fill="#00933C"/>
            <circle cx="88" cy="29" r="7" fill="#B933AD"/>
            <circle cx="112" cy="46" r="9" fill="#FCCC0A" stroke="#fff" stroke-width="3"/>
          </svg>
        </div>
        <div class="app-title">Live Map</div>
        <div class="app-description">
          System-wide view of trains currently arriving at stations
        </div>
        <div class="feature-list">
          <div class="feature-item">Entire subway map view</div>
          <div class="feature-item">Line-by-line strip maps</div>
          <div class="feature-item">Direction and destination labels</div>
          <div class="feature-item">Route filters and train details</div>
          <div class="feature-item">Automatic 15-second refresh</div>
        </div>
      </a>
`;
}

function injectLiveMapCard(body) {
  if (typeof body !== 'string' || !body.includes('NYC TRANSIT DISPLAY HUB')) return body;
  if (body.includes('href="/live-map"')) return body;

  const ferryMarker = '      <a href="/ferry"';
  if (body.includes(ferryMarker)) {
    return body.replace(ferryMarker, `${liveMapCardHtml()}${ferryMarker}`);
  }

  const cardsEndMarker = '    </div>\n\n    <footer';
  if (body.includes(cardsEndMarker)) {
    return body.replace(cardsEndMarker, `${liveMapCardHtml()}    </div>\n\n    <footer`);
  }

  return body;
}

// Wrap only the existing landing-page handler so the original app remains intact.
const originalGet = express.application.get;
express.application.get = function patchedGet(routePath, ...handlers) {
  if (handlers.length === 0) {
    return originalGet.call(this, routePath);
  }

  if (routePath === '/') {
    handlers = handlers.map(handler => function liveMapLandingWrapper(req, res, next) {
      const originalSend = res.send.bind(res);
      res.send = body => originalSend(injectLiveMapCard(body));
      return handler(req, res, next);
    });
  }

  return originalGet.call(this, routePath, ...handlers);
};

// app.js calls listen after registering all of its routes. Add ours immediately
// before the real listener starts.
const originalListen = express.application.listen;
express.application.listen = function patchedListen(...args) {
  installLiveMapRoutes(this);
  return originalListen.apply(this, args);
};

require('./app');
