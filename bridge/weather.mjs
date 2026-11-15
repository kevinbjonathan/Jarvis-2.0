/**
 * Instant weather, free and keyless.
 *
 * The model used to answer "what's the weather?" by searching the web — a full
 * reasoning + web round trip that took many long seconds. Forecast data is a
 * lookup, not a synthesis, so it should not be a synthesis. This module calls
 * Open-Meteo directly: one tiny request for the location, one for the
 * forecast, no account, no API key, no billing.
 *
 * Two consumers, same data:
 *   - the model-facing tool weather_forecast (the brain reads it out),
 *   - quickWeather() for the fast command router, so "what's the weather?"
 *     never touches the brain at all.
 *
 * Three things keep it fast and cheap:
 *   - a preferred location (the "weather_location" preference) so it does not
 *     geocode the same city every time you ask;
 *   - a short memory cache (10 minutes) so repeated questions do not hammer
 *     the API; "refresh the weather" bypasses it;
 *   - geocodes cached in memory for the life of the process.
 */

import { geocode, forecastFor, speakable } from './weather-core.mjs'
import { readPref } from './preferences.mjs'

export const CACHE_TTL_MS = 10 * 60_000

const DEFAULT_PLACE = 'London'
const IP_LOCATE = 'https://ipapi.co/json/'
const FETCH_TIMEOUT_MS = 6000

/* ------------------------------------------------------------------- memory */

const geocodeCache = new Map()
const ipCityCache = { name: null, at: 0, ttl: 12 * 60 * 60_000 }

/** Geocode with a per-process memory cache. */
async function geo(name) {
  const key = name.trim().toLowerCase()
  const hit = geocodeCache.get(key)
  if (hit) return hit
  const loc = await geocode(name.trim())
  geocodeCache.set(key, loc)
  return loc
}

/** The user's preferred city, resolved once. */
function preferredPlace() {
  return readPref('weather_location')
}

/**
 * City for an unsaid "what's the weather?": the stored preference wins,
 * then a free no-key IP lookup once a day, then a fixed default. The IP
 * result is only ever a memory cache — telling JARVIS where you are is a
 * preference, and that is a write the user has to make.
 */
async function defaultLocation() {
  const pref = preferredPlace()
  if (pref) {
    const p = typeof pref === 'string' ? pref.trim() : ''
    if (p) return geo(p)
  }
  if (Date.now() - ipCityCache.at > ipCityCache.ttl) {
    try {
      const res = await fetch(IP_LOCATE, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (res.ok) {
        const j = await res.json()
        const city = String(j?.city ?? '').trim()
        if (city) {
          const region = String(j?.region ?? '').trim()
          const country = String(j?.country ?? '').trim()
          ipCityCache.name = [city, region, country].filter(Boolean).join(', ')
        }
      }
    } catch {
      /* offline — use whatever we have */
    }
    ipCityCache.at = Date.now()
  }
  if (ipCityCache.name) return geo(ipCityCache.name)
  return geo(DEFAULT_PLACE)
}

/* ------------------------------------------------------------------- cache */

const forecastCache = new Map()

function cacheKey(loc, unit) {
  return `${loc.latitude.toFixed(3)},${loc.longitude.toFixed(3)}|${unit}`
}

/** Current conditions + a 2-day forecast, cached for CACHE_TTL_MS. */
async function forecastCached(loc, unit, refresh) {
  const key = cacheKey(loc, unit)
  const hit = forecastCache.get(key)
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.data
  }
  const data = await forecastFor(loc, unit)
  forecastCache.set(key, { at: Date.now(), data })
  return data
}

/** What units to use: tolk preference, then celsius. */
function preferUnit() {
  // Accept either name — the router and the model both read it here.
  const u = readPref('temperature_unit') ?? readPref('units')
  return String(u ?? '').toLowerCase().includes('fahr') ? 'fahrenheit' : 'celsius'
}

/**
 * The fast path — a one-line, speakable forecast, or a short error string.
 * Used by the fast command router so a bare weather question needs no brain.
 */
export async function quickWeather({ refresh, location } = {}) {
  const unit = preferUnit()
  const place = location?.trim()
    ? await geo(location.trim())
    : await defaultLocation()
  const data = await forecastCached(place, unit, Boolean(refresh))
  return speakable(data, place)
}

/** How stale the current cache is (ms), for the status readout. */
export function weatherCacheAge() {
  let age = Infinity
  const unit = preferUnit()
  for (const [key, entry] of forecastCache) {
    if (key.endsWith(`|${unit}`)) age = Math.min(age, Date.now() - entry.at)
  }
  return Number.isFinite(age) ? Math.round(age / 1000) : null
}

export function weatherServer() {
  return {
    tools: [
      {
        name: 'weather_forecast',
        description:
          'Current conditions plus a 2-day forecast for any city, fetched instantly from a free weather API. Use this for any weather question — give it the place: weather_forecast for "what is the weather in Tokyo". Never search the web for weather first; this tool is faster, free, and has data in a single call. With no location it uses the user\'s saved weather location (or their network location).',
        inputSchema: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              description:
                'A city or place name, e.g. "London" or "San Francisco". A specific place found in the user\'s request is better than latitude/longitude.',
            },
            latitude: { type: 'number', description: 'Optional exact coordinates, if known.' },
            longitude: { type: 'number', description: 'Optional exact coordinates, if known.' },
            units: {
              type: 'string',
              enum: ['celsius', 'fahrenheit'],
              description: 'Defaults to the saved preference (usually celsius).',
            },
            refresh: {
              type: 'boolean',
              description: 'True to bypass the cache and fetch fresh data ("refresh the weather").',
            },
          },
          required: [],
        },
        handler: async (args) => {
          const t0 = Date.now()
          const refresh = args?.refresh === true
          const unit = args?.units === 'fahrenheit' || args?.units === 'celsius' ? args.units : preferUnit()
          try {
            let place
            if (Number.isFinite(args?.latitude) && Number.isFinite(args?.longitude)) {
              place = {
                name: args.location ?? 'the given coordinates',
                admin1: '',
                country: '',
                latitude: args.latitude,
                longitude: args.longitude,
              }
            } else if (typeof args?.location === 'string' && args.location.trim()) {
              place = await geo(args.location.trim())
            } else {
              place = await defaultLocation()
            }
            const data = await forecastCached(place, unit, refresh)
            const speak = speakable(data, place)
            const cached = (() => {
              const hit = forecastCache.get(cacheKey(place, unit))
              return hit ? ` (cached ${Math.round((Date.now() - hit.at) / 1000)}s ago)` : ''
            })()
            console.log(`[weather] answered in ${Date.now() - t0} ms${cached}`)
            return speak
          } catch (err) {
            console.warn(`[weather] failed in ${Date.now() - t0} ms:`, err?.message ?? err)
            return `The weather service is unreachable: ${String(err?.message ?? err)}.`
          }
        },
      },
    ],
  }
}