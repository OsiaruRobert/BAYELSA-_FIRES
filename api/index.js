import express from "express";

const app = express();

const FIRMS_MAP_KEY = process.env.FIRMS_MAP_KEY;
if (!FIRMS_MAP_KEY) {
  console.error("Missing FIRMS_MAP_KEY environment variable");
  process.exit(1);
}

// Optional: only post to a webhook if you actually have one configured
const TARGET_WEBHOOK_URL = process.env.TARGET_WEBHOOK_URL || "";

const BAYELSA_BBOX = "5.35,4.25,6.65,5.40";
const AFRICA_BBOX = "-26.0,-36.0,64.0,38.0";

const AREA_BBOX = BAYELSA_BBOX;
const SOURCE = "VIIRS_NOAA20_NRT";
const DAY_RANGE = 2;

// Dedupe cache: keeps events for 7 days (> DAY_RANGE), then prunes.
const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const KNOWN_FLARES = [
  [4.8512, 6.1234],
];

const seenEvents = new Map(); // eventId -> timestamp (ms)
let inFlight = null;          // prevents duplicate concurrent FIRMS calls

function isKnownFlare(lat, lon, threshold = 0.005) {
  return KNOWN_FLARES.some(
    ([fLat, fLon]) =>
      Math.abs(lat - fLat) < threshold && Math.abs(lon - fLon) < threshold
  );
}

function pruneSeen(now = Date.now()) {
  for (const [id, ts] of seenEvents) {
    if (now - ts > SEEN_TTL_MS) seenEvents.delete(id);
  }
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function parseCsv(csvText) {
  const lines = csvText
    .replace(/^\uFEFF/, "")     // strip BOM
    .trim()
    .split(/\r?\n/);            // handle CRLF
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.trim());
  return lines
    .slice(1)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const values = line.split(",");
      return headers.reduce((obj, header, index) => {
        obj[header] = values[index]?.trim();
        return obj;
      }, {});
    });
}

// FIRMS acq_time is "HHMM" (e.g. "0042"); build a valid ISO timestamp.
function toIsoAcqTime(date, time) {
  if (!date || !time) return null;
  const hhmm = String(time).padStart(4, "0");
  const iso = `${date}T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

async function checkFires() {
  pruneSeen();

  const url =
    `https://firms.modaps.eosdis.nasa.gov/api/area/csv/` +
    `${encodeURIComponent(FIRMS_MAP_KEY)}/${SOURCE}/${AREA_BBOX}/${DAY_RANGE}`;

  console.log("Fetching:", url);

  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    throw new Error(`FIRMS API error: ${response.status} ${response.statusText}`);
  }

  const csvText = await response.text();
  const rows = parseCsv(csvText);
  console.log(`Total detections found: ${rows.length}`);

  const matches = [];

  for (const row of rows) {
    const lat = num(row.latitude);
    const lon = num(row.longitude);
    if (lat === null || lon === null) continue;

    const eventId = `${lat}_${lon}_${row.acq_date}_${row.acq_time}`;

    if (seenEvents.has(eventId)) continue;
    if (row.confidence === "l") continue;
    if (isKnownFlare(lat, lon)) continue;

    const payload = {
      latitude: lat,
      longitude: lon,
      brightness_k: num(row.bright_ti4),
      frp_mw: num(row.frp),
      confidence: row.confidence ?? null,
      acquired_at: toIsoAcqTime(row.acq_date, row.acq_time),
      satellite: row.satellite ?? null,
    };

    
    if (TARGET_WEBHOOK_URL) {
      try {
        const webhookRes = await fetch(TARGET_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
        });
        if (!webhookRes.ok) {
          console.warn(`Webhook failed for ${eventId}: ${webhookRes.status}`);
          continue; // do NOT mark as seen → retried next run
        }
      } catch (err) {
        console.warn(`Webhook error for ${eventId}: ${err.message}`);
        continue;
      }
    }

    // Mark only after it was actually delivered (or if webhook disabled)
    seenEvents.set(eventId, Date.now());
    matches.push(payload);
    console.log("Matched fire payload:", payload);
  }

  return matches;
}

app.get("/", async (req, res) => {
  try {
    // Coalesce concurrent requests into a single FIRMS call
    if (!inFlight) {
      inFlight = checkFires().finally(() => {
        inFlight = null;
      });
    }
    const data = await inFlight;
    res.json(data);
  } catch (error) {
    console.error("Error checking fires:", error.message);
    res.status(500).json({ error: "Failed to fetch fire data" });
  }
});

app.listen(process.env.PORT || 2000, () => console.log("Running..."));