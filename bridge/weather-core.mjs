/**
 * The pure weather pulling in weather.mjs — no state, no caching, no
 * preferences. Keeping it separate lets weather.mjs wrap it in a preference
 * layer and a memory cache without this file growing policy.
 */

const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST = 'https://api.open-meteo.com/v1/forecast'
const FETCH_TIMEOUT_MS = 8000

/** WMO weather interpretation codes, abbreviated to what a spoken answer needs. */
const WMO = {
  0: 'clear sky',
  1: 'mainly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'freezing fog',
  51: 'light drizzle',
  53: 'drizzle',
  55: 'heavy drizzle',
  61: 'light rain',
  63: 'rain',
  65: 'heavy rain',
  66: 'freezing rain',
  67: 'heavy freezing rain',
  71: 'light snow',
  73: 'snow',
  75: 'heavy snow',
  77: 'snow grains',
  80: 'light showers',
  81: 'showers',
  82: 'violent showers',
  85: 'snow showers',
  86: 'heavy snow showers',
  95: 'thunderstorm',
  96: 'thunderstorm with hail',
  99: 'severe thunderstorm with hail',
}

const code = (n) => WMO[n] ?? `code ${n}`

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`weather API said HTTP ${res.status}`)
  return res.json()
}

/** Turn a place name into a coordinate. Free, no key. */
export async function geocode(name) {
  const t0 = Date.now()
  const q = new URLSearchParams({
    name,
    count: '1',
    language: 'en',
    format: 'json',
  })
  let data = await getJson(`${GEOCODE}?${q}`)
  // "London, UK" matches nothing at Open-Meteo — the comma is not part of a
  // place there. Fall back to the bare city so a spoken "London, England"
  // still resolves instead of erroring.
  if (!data.results?.length && /,/.test(name)) {
    const city = name.replace(/,.*$/, '').trim()
    if (city && city !== name) {
      const q2 = new URLSearchParams({ name: city, count: '1', language: 'en', format: 'json' })
      data = await getJson(`${GEOCODE}?${q2}`)
    }
  }
  const hit = data.results?.[0]
  if (!hit?.latitude || !hit?.longitude) {
    throw new Error(`could not find a place called “${name}”`)
  }
  console.log(`[weather] geocoded “${name}” in ${Date.now() - t0} ms`)
  return {
    name: hit.name ?? name,
    admin1: hit.admin1 ?? '',
    country: hit.country ?? '',
    latitude: hit.latitude,
    longitude: hit.longitude,
  }
}

/** Fetch the 2-day forecast block; no cache, no policy. */
export async function forecastFor(loc, unit) {
  const unitParam = unit === 'fahrenheit' ? 'fahrenheit' : 'celsius'
  const t0 = Date.now()
  const q = new URLSearchParams({
    latitude: loc.latitude,
    longitude: loc.longitude,
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: '2',
    temperature_unit: unitParam,
    wind_speed_unit: 'kmh',
  })
  const data = await getJson(`${FORECAST}?${q}`)
  console.log(`[weather] API completed in ${Date.now() - t0} ms`)
  return data
}

/** The one-number shape a caller can read straight out loud. */
export function speakable(data, place) {
  const cur = data.current
  const today = data.daily
  const lines = [
    `${place.name}${place.admin1 ? `, ${place.admin1}` : ''}${place.country ? `, ${place.country}` : ''}:`,
    `now: ${Math.round(cur.temperature_2m)}${data.current_units?.temperature_2m ?? '°'}, ${code(cur.weather_code)}, feels like ${Math.round(cur.apparent_temperature)}${data.current_units?.apparent_temperature ?? '°'}, ${Math.round(cur.relative_humidity_2m)}% humidity, wind ${Math.round(cur.wind_speed_10m)} ${data.current_units?.wind_speed_10m ?? 'km/h'}.`,
    `today: high ${Math.round(today.temperature_2m_max?.[0])}°, low ${Math.round(today.temperature_2m_min?.[0])}°, ${code(today.weather_code?.[0])}${today.precipitation_probability_max?.[0] != null ? `, ${Math.round(today.precipitation_probability_max[0])}% chance of precipitation` : ''}.`,
  ]
  if (today.temperature_2m_max?.[1] != null) {
    lines.push(
      `tomorrow: high ${Math.round(today.temperature_2m_max[1])}°, low ${Math.round(today.temperature_2m_min[1])}°, ${code(today.weather_code?.[1])}.`,
    )
  }
  return lines.join('\n')
}