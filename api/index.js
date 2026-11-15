import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();


const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "public")));


const FIRMS_MAP_KEY = process.env.FIRMS_MAP_KEY;
if (!FIRMS_MAP_KEY) {
  console.error("Missing FIRMS_MAP_KEY environment variable");
  process.exit(1);
}

const TARGET_WEBHOOK_URL = process.env.TARGET_WEBHOOK_URL || "";

const BAYELSA_BBOX = "5.35,4.25,6.65,5.40";
const AFRICA_BBOX = "-26.0,-36.0,64.0,38.0";

// const AREA_BBOX = "world";
const AREA_BBOX = BAYELSA_BBOX;
const SOURCE = "VIIRS_NOAA20_NRT";
const DAY_RANGE = 1;

const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days > DAY_RANGE

const KNOWN_FLARES = [[4.8512, 6.1234]];
const seenEvents = new Map(); // eventId -> timestamp
let inFlight = null;

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

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// FIRMS returns plain text on error, CSV on success. Detect both.
function parseFirmsCsv(csvText) {
  const cleaned = csvText.replace(/^\uFEFF/, "").trim();
  const lines = cleaned.split(/\r?\n/).filter((l) => l.trim() !== "");

  if (lines.length === 0) {
    throw new Error("FIRMS returned an empty body");
  }

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  if (!headers.includes("latitude") || !headers.includes("longitude")) {
    // Plain-text error like "Invalid MAP_KEY ..." or "Invalid source ..."
    throw new Error(`FIRMS error response: ${cleaned.slice(0, 300)}`);
  }

  if (lines.length < 2) return []; // valid CSV, zero rows

  const realHeaders = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    return realHeaders.reduce((obj, h, i) => {
      obj[h] = values[i]?.trim();
      return obj;
    }, {});
  });
}

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

  console.log("Fetching:", url.replace(FIRMS_MAP_KEY, "***"));

  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    throw new Error(`FIRMS HTTP ${response.status} ${response.statusText}`);
  }

  const csvText = await response.text();
  const rows = parseFirmsCsv(csvText);
  console.log(`Total detections found: ${rows.length}`);

  const fires = [];
  let newCount = 0;

  for (const row of rows) {
    const lat = num(row.latitude);
    const lon = num(row.longitude);
    if (lat === null || lon === null) continue;
    if (row.confidence === "l") continue;
    if (isKnownFlare(lat, lon)) continue;

    const eventId = `${lat}_${lon}_${row.acq_date}_${row.acq_time}`;
    const isNew = !seenEvents.has(eventId);

    const payload = {
      latitude: lat,
      longitude: lon,
      brightness_k: num(row.bright_ti4),
      frp_mw: num(row.frp),
      confidence: row.confidence ?? null,
      acquired_at: toIsoAcqTime(row.acq_date, row.acq_time),
      satellite: row.satellite ?? null,
      is_new: isNew,
    };

    // Fire webhook only for genuinely new events; if it fails, retry next call.
    if (isNew && TARGET_WEBHOOK_URL) {
      try {
        const r = await fetch(TARGET_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) {
          console.warn(`Webhook ${eventId} -> HTTP ${r.status} (will retry)`);
          continue; // keep is_new on next call
        }
      } catch (err) {
        console.warn(`Webhook ${eventId} error: ${err.message} (will retry)`);
        continue;
      }
    }

    if (isNew) {
      seenEvents.set(eventId, Date.now());
      newCount++;
    }
    fires.push(payload);
  }

  return {
    count: fires.length,
    new_count: newCount,
    fires,
    fetched_at: new Date().toISOString(),
    area: AREA_BBOX,
    source: SOURCE,
    day_range: DAY_RANGE,
    webhook_enabled: Boolean(TARGET_WEBHOOK_URL),
  };
}

app.get("/fires", async (req, res) => {
  try {
    if (!inFlight) {
      inFlight = checkFires().finally(() => {
        inFlight = null;
      });
    }
    res.json(await inFlight);
  } catch (error) {
    console.error("Error checking fires:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Raw diagnostic: bypasses filters and dedup, shows what FIRMS actually sent
app.get("/debug", async (req, res) => {
  const url =
    `https://firms.modaps.eosdis.nasa.gov/api/area/csv/` +
    `${encodeURIComponent(FIRMS_MAP_KEY)}/${SOURCE}/${AREA_BBOX}/${DAY_RANGE}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const body = await r.text();
    const lines = body.split(/\r?\n/);
    res.json({
      status: r.status,
      content_type: r.headers.get("content-type"),
      bytes: body.length,
      line_count: lines.length,
      header: lines[0],
      preview: body.slice(0, 500),
      errors: r.ok ? null : body.slice(0, 300),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((req, res) => {
  console.log("hit");
  res.json({
    "y": 1
  })
})
app.listen(process.env.PORT || 2000, () => console.log("Running..."));