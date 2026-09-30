const fs = require('fs');
const raw = JSON.parse(fs.readFileSync('./src/data/dashboard_data.json', 'utf8'));

function adaptStationStatus(status, stationId) {
  switch (status) {
    case 'reporting':
      return { displayStatus: 'reporting_in_dataset', displayStatusLabel: 'Reporting in dataset' };
    case 'silent':
      return { displayStatus: 'no_usable_data', displayStatusLabel: 'No usable data in this dataset' };
    default:
      throw new Error(`[Adapter Error] Unrecognized station status: "${status}" for station "${stationId}".`);
  }
}

function adaptCityStatus(cityStatus, cityName) {
  switch (cityStatus) {
    case 'all_reporting':
      return { displayStatus: 'all_reporting', displayStatusLabel: 'All reporting in dataset' };
    case 'partial':
      return { displayStatus: 'partial_reporting', displayStatusLabel: 'Partial reporting in dataset' };
    case 'no_working_station':
      return { displayStatus: 'no_usable_data', displayStatusLabel: 'No usable data in this dataset' };
    default:
      throw new Error(`[Adapter Error] Unrecognized city status: "${cityStatus}" for city "${cityName}".`);
  }
}

function adaptGapCityType(type, cityName) {
  switch (type) {
    case 'never_registered':
      return { displayType: 'never_registered', displayTypeLabel: 'Never registered' };
    case 'registered_silent':
      return { displayType: 'registered_no_usable_data', displayTypeLabel: 'Registered with no usable data in this dataset' };
    default:
      throw new Error(`[Adapter Error] Unrecognized gap city type: "${type}" for gap city "${cityName}".`);
  }
}

// 1. Validate and accumulate counts
const stationCounts = { reporting: 0, no_usable_data: 0 };
for (const s of raw.stations) {
  const res = adaptStationStatus(s.status, s.id);
  if (res.displayStatus === 'reporting_in_dataset') stationCounts.reporting++;
  else if (res.displayStatus === 'no_usable_data') stationCounts.no_usable_data++;
}

const gapCityCounts = { total: raw.gap_cities.length, never_registered: 0, registered_silent: 0 };
for (const g of raw.gap_cities) {
  const res = adaptGapCityType(g.type, g.city);
  if (res.displayType === 'never_registered') gapCityCounts.never_registered++;
  else if (res.displayType === 'registered_no_usable_data') gapCityCounts.registered_silent++;
}

const cityCounts = { total: raw.cities.length, no_working_station: 0, all_reporting: 0, partial: 0 };
for (const c of raw.cities) {
  const res = adaptCityStatus(c.city_status, c.city);
  if (res.displayStatus === 'no_usable_data') cityCounts.no_working_station++;
  else if (res.displayStatus === 'all_reporting') cityCounts.all_reporting++;
  else if (res.displayStatus === 'partial_reporting') cityCounts.partial++;
}

console.log('=== ADAPTER VERIFICATION COUNTS BY STATUS ===');
console.log('Stations:');
console.log('  - Reporting in dataset:', stationCounts.reporting);
console.log('  - No usable data in this dataset:', stationCounts.no_usable_data);
console.log('  - Total Stations:', raw.stations.length);
console.log('Gap Cities:');
console.log('  - Total Gap Cities:', gapCityCounts.total);
console.log('  - Never registered:', gapCityCounts.never_registered);
console.log('  - Registered with no usable data (registered_silent):', gapCityCounts.registered_silent);
console.log('Cities:');
console.log('  - No working station (no usable data):', cityCounts.no_working_station);
console.log('  - All reporting:', cityCounts.all_reporting);
console.log('  - Partial:', cityCounts.partial);
console.log('  - Total Cities:', cityCounts.total);

// 2. Validate runtime assertions
try {
  adaptStationStatus('invalid_status', 'TEST001');
  console.error('FAILED: assertion did not throw on invalid station status');
} catch (e) {
  console.log('Assertion Check 1 Passed:', e.message);
}

try {
  adaptCityStatus('invalid_city_status', 'TestCity');
  console.error('FAILED: assertion did not throw on invalid city status');
} catch (e) {
  console.log('Assertion Check 2 Passed:', e.message);
}

try {
  adaptGapCityType('invalid_gap_type', 'TestGapCity');
  console.error('FAILED: assertion did not throw on invalid gap type');
} catch (e) {
  console.log('Assertion Check 3 Passed:', e.message);
}
