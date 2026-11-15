// const FIRMS_MAP_KEY = "PASTE_YOUR_ACTUAL_MAP_KEY_HERE";
const TARGET_WEBHOOK_URL = "https://example.com"; // Replace with your webhook URL when ready

const BAYELSA_BBOX = "5.35,4.25,6.65,5.40";
const AFRICA_BBOX = "-26.0,-36.0,64.0,38.0";

// Use AFRICA_BBOX first to verify you get live rows, then switch to BAYELSA_BBOX
const AREA_BBOX = "world";
const SOURCE = "VIIRS_NOAA20_NRT";
const DAY_RANGE = 2;

const KNOWN_FLARES = [
  [4.8512, 6.1234],
];
///api/area/csv//5.35,4.25,6.55,5.4/1/2026-11-14
const seenEvents = new Set();

function isKnownFlare(lat, lon, threshold = 0.005) {
  return KNOWN_FLARES.some(
    ([fLat, fLon]) =>
      Math.abs(lat - fLat) < threshold && Math.abs(lon - fLon) < threshold
  );
}

function parseCsv(csvText) {
  const lines = csvText.trim().split("\n");
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    return headers.reduce((obj, header, index) => {
      obj[header] = values[index]?.trim();
      return obj;
    }, {});
  });
}

async function checkFires() {
//area_url = '' + MAP_KEY + '/VIIRS_NOAA20_NRT/world/1'
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${FIRMS_MAP_KEY}/${SOURCE}/${AREA_BBOX}/${DAY_RANGE}`;

  console.log("Fetching:", url);

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      throw new Error(`FIRMS API error: ${response.status} ${response.statusText}`);
    }

    const csvText = await response.text();
    const rows = parseCsv(csvText);

    console.log(`Total detections found: ${rows.length}`);
    if (rows.length > 0) {
      console.table(rows.slice(0, 5)); // Preview first 5 rows in console
    } else {
      console.log("Raw response:", csvText);
    }

    for (const row of rows) {
      const lat = parseFloat(row.latitude);
      const lon = parseFloat(row.longitude);
      const eventId = `${lat}_${lon}_${row.acq_date}_${row.acq_time}`;

      if (seenEvents.has(eventId)) continue;
      if (row.confidence === "l") continue;
      if (isKnownFlare(lat, lon)) continue;

      seenEvents.add(eventId);

      const payload = {
        latitude: lat,
        longitude: lon,
        brightness_k: parseFloat(row.bright_ti4),
        frp_mw: parseFloat(row.frp),
        confidence: row.confidence,
        acquired_at: `${row.acq_date}T${row.acq_time}Z`,
        satellite: row.satellite,
      };

      console.log("Matched fire payload:", payload);

      // Uncomment below when TARGET_WEBHOOK_URL is set to your real endpoint:
      /*
      const webhookRes = await fetch(TARGET_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
      console.log(`Webhook status for ${eventId}: ${webhookRes.status}`);
      */
    }
  } catch (error) {
    console.error("Error checking fires:", error.message);
  }
}

checkFires();
