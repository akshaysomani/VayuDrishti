/**
 * Open-Meteo Archive API Pilot Script
 * Compares ERA5 vs ERA5-Land for Delhi, Mumbai, and Kolkata (Year 2020)
 */

interface DailyData {
  time: string[];
  precipitation_sum?: number[];
  [key: string]: any;
}

interface OpenMeteoArchiveResponse {
  latitude: number;
  longitude: number;
  elevation: number;
  daily_units: Record<string, string>;
  daily: DailyData;
}

const PILOT_CITIES = [
  { name: 'Delhi', lat: 28.6484, lon: 77.1706 },
  { name: 'Mumbai', lat: 19.0940, lon: 72.8534 },
  { name: 'Kolkata', lat: 22.5467, lon: 88.3669 },
];

async function fetchModelData(
  city: { name: string; lat: number; lon: number },
  model: 'era5_land' | 'era5',
  startDate: string,
  endDate: string
) {
  // If model is era5_land, pass models=era5_land. If era5, pass models=era5.
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${city.lat}&longitude=${city.lon}&start_date=${startDate}&end_date=${endDate}&daily=precipitation_sum&timezone=UTC&models=${model}`;
  
  console.log(`\nFetching ${city.name} (${model})...`);
  console.log(`URL: ${url}`);
  
  const startTime = Date.now();
  const res = await fetch(url);
  const elapsed = Date.now() - startTime;
  
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${errorText}`);
  }
  
  const text = await res.text();
  const sizeBytes = Buffer.byteLength(text, 'utf8');
  const json: OpenMeteoArchiveResponse = JSON.parse(text);
  
  // The daily key might be 'precipitation_sum' or 'precipitation_sum_era5_land' / 'precipitation_sum_era5'
  const daily = json.daily;
  let precArray: number[] | undefined = daily.precipitation_sum;
  if (!precArray) {
    // Check prefixed key
    const altKey = Object.keys(daily).find((k) => k.startsWith('precipitation_sum'));
    if (altKey) {
      precArray = daily[altKey];
    }
  }

  if (!precArray) {
    throw new Error(`Could not find precipitation_sum in response keys: ${Object.keys(daily).join(', ')}`);
  }

  // Validate values
  let nonNegative = true;
  let nanCount = 0;
  let nullCount = 0;
  let totalRain = 0;
  let wetDays = 0;
  let maxDaily = 0;

  for (const v of precArray) {
    if (v === null || v === undefined) {
      nullCount++;
    } else if (Number.isNaN(v)) {
      nanCount++;
    } else {
      if (v < 0) nonNegative = false;
      totalRain += v;
      if (v >= 1.0) wetDays++;
      if (v > maxDaily) maxDaily = v;
    }
  }

  return {
    url,
    sizeBytes,
    elapsedMs: elapsed,
    days: precArray.length,
    unit: json.daily_units?.precipitation_sum || json.daily_units?.[Object.keys(json.daily_units)[0]] || 'mm',
    nonNegative,
    nullCount,
    nanCount,
    totalRain: Number(totalRain.toFixed(1)),
    wetDays,
    maxDaily: Number(maxDaily.toFixed(1)),
  };
}

async function main() {
  console.log('================================================================');
  console.log('OPEN-METEO ARCHIVE API PILOT (3 CITIES x 2020: ERA5 vs ERA5-LAND)');
  console.log('================================================================');

  const results: any[] = [];

  for (const city of PILOT_CITIES) {
    // polite delay
    await new Promise((r) => setTimeout(r, 600));
    const landRes = await fetchModelData(city, 'era5_land', '2020-01-01', '2020-12-31');
    
    await new Promise((r) => setTimeout(r, 600));
    const era5Res = await fetchModelData(city, 'era5', '2020-01-01', '2020-12-31');

    results.push({ city: city.name, land: landRes, era5: era5Res });
  }

  console.log('\n================================================================');
  console.log('PILOT COMPARISON SUMMARY TABLE');
  console.log('================================================================');
  console.log(
    'City'.padEnd(12) +
    'Model'.padEnd(12) +
    'Days'.padStart(6) +
    'Unit'.padStart(6) +
    'Total(mm)'.padStart(12) +
    'WetDays'.padStart(10) +
    'MaxDay(mm)'.padStart(12) +
    'Null/NaN'.padStart(10) +
    'Size(B)'.padStart(10)
  );
  console.log('-'.repeat(80));

  for (const r of results) {
    console.log(
      r.city.padEnd(12) +
      'ERA5-Land'.padEnd(12) +
      String(r.land.days).padStart(6) +
      r.land.unit.padStart(6) +
      String(r.land.totalRain).padStart(12) +
      String(r.land.wetDays).padStart(10) +
      String(r.land.maxDaily).padStart(12) +
      `${r.land.nullCount}/${r.land.nanCount}`.padStart(10) +
      String(r.land.sizeBytes).padStart(10)
    );
    console.log(
      r.city.padEnd(12) +
      'ERA5'.padEnd(12) +
      String(r.era5.days).padStart(6) +
      r.era5.unit.padStart(6) +
      String(r.era5.totalRain).padStart(12) +
      String(r.era5.wetDays).padStart(10) +
      String(r.era5.maxDaily).padStart(12) +
      `${r.era5.nullCount}/${r.era5.nanCount}`.padStart(10) +
      String(r.era5.sizeBytes).padStart(10)
    );
  }
}

main().catch(console.error);
