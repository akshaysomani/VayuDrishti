"""
Honest Cross-Check: Open-Meteo (ERA5) vs Local CHIRPS v3 SAT (1998-2001)
========================================================================
Compares Open-Meteo ERA5 daily precipitation with local CHIRPS NetCDF
slices for 3 Indian cities (Delhi, Mumbai, Kolkata) over 1998-2001.

Reports:
- Overlapping date range (1998-01-01 to 2001-12-31, 1461 days)
- Pearson correlation coefficient (r)
- Mean daily bias (ERA5 - CHIRPS, in mm/day)
- Mean rainfall (mm/day) for both
- Count of Heavy Rain days (>= 64.5 mm/day) in each dataset
"""

import os
import glob
import json
import numpy as np
import xarray as xr

CHIRPS_DIR = os.path.join(os.getcwd(), "ERA5-Land", "CHIRPS_INDIA")
CACHE_DIR = os.path.join(os.getcwd(), "cache", "open_meteo_rainfall")

CITIES = [
    {"name": "Delhi", "lat": 28.6358, "lon": 77.2144, "file": "Delhi_1991_2020.json"},
    {"name": "Mumbai", "lat": 19.0760, "lon": 72.8777, "file": "Mumbai_1991_2020.json"},
    {"name": "Kolkata", "lat": 22.5726, "lon": 88.3639, "file": "Kolkata_1991_2020.json"},
]

def load_chirps_series(lat: float, lon: float):
    # Collect all netcdf files for 1998-2001
    nc_files = sorted(glob.glob(os.path.join(CHIRPS_DIR, "*", "*.nc")))
    if not nc_files:
        raise RuntimeError(f"No CHIRPS NetCDF files found in {CHIRPS_DIR}")

    chirps_dates = []
    chirps_values = []

    for fpath in nc_files:
        with xr.open_dataset(fpath) as ds:
            # select nearest grid cell
            pt = ds.sel(latitude=lat, longitude=lon, method="nearest")
            times = pt["time"].values.astype("datetime64[D]").astype(str)
            vals = pt["rainfall"].values
            chirps_dates.extend(times)
            chirps_values.extend(vals)

    # Sort and clean
    combined = sorted(zip(chirps_dates, chirps_values), key=lambda x: x[0])
    dates = [c[0] for c in combined]
    # Replace NaNs or negative with 0.0 or nan
    vals = np.array([c[1] for c in combined], dtype=float)
    vals = np.nan_to_num(vals, nan=0.0)
    vals = np.clip(vals, 0.0, None)
    return dates, vals

def load_open_meteo_series(city_file: str):
    fpath = os.path.join(CACHE_DIR, city_file)
    with open(fpath, "r", encoding="utf-8") as f:
        data = json.load(f)
    dates = data["daily"]["time"]
    precip = np.array(data["daily"]["precipitation_sum"], dtype=float)
    return dict(zip(dates, precip))

def main():
    print("==========================================================================================")
    print("HONEST CROSS-CHECK: OPEN-METEO ERA5 vs LOCAL CHIRPS v3 SAT (1998-2001)")
    print("==========================================================================================")
    print("Note: The overlap window is short (1998-01-01 to 2001-12-31, 4 years / 1461 days).")
    print("CHIRPS v3 is at ~0.05° (~5 km) satellite-gauge; ERA5 is at 0.25° (~25-30 km) reanalysis.")
    print("All numbers are reported as-is with no calibration or tuning.\n")

    results = []

    for city in CITIES:
        chirps_dates, chirps_vals = load_chirps_series(city["lat"], city["lon"])
        om_dict = load_open_meteo_series(city["file"])

        overlap_dates = []
        c_vals = []
        om_vals = []

        for d, cv in zip(chirps_dates, chirps_vals):
            if d in om_dict:
                overlap_dates.append(d)
                c_vals.append(cv)
                om_vals.append(om_dict[d])

        c_arr = np.array(c_vals)
        om_arr = np.array(om_vals)

        n = len(overlap_dates)
        corr = float(np.corrcoef(om_arr, c_arr)[0, 1]) if n > 1 else 0.0
        mean_om = float(np.mean(om_arr))
        mean_chirps = float(np.mean(c_arr))
        bias = mean_om - mean_chirps
        mae = float(np.mean(np.abs(om_arr - c_arr)))

        # Count of days >= 64.5 mm (IMD Heavy Rain threshold)
        heavy_om = int(np.sum(om_arr >= 64.5))
        heavy_chirps = int(np.sum(c_arr >= 64.5))

        results.append({
            "city": city["name"],
            "lat": city["lat"],
            "lon": city["lon"],
            "n_days": n,
            "date_range": f"{overlap_dates[0]} to {overlap_dates[-1]}",
            "correlation_r": round(corr, 4),
            "mean_om_mm": round(mean_om, 2),
            "mean_chirps_mm": round(mean_chirps, 2),
            "mean_bias_mm": round(bias, 2),
            "mae_mm": round(mae, 2),
            "heavy_days_om": heavy_om,
            "heavy_days_chirps": heavy_chirps,
        })

    # Print Table
    print(
        "City".ljust(12) +
        "Overlap".rjust(10) +
        "r (corr)".rjust(10) +
        "OM Mean".rjust(10) +
        "CHIRPS Mean".rjust(13) +
        "Bias(mm)".rjust(10) +
        "MAE(mm)".rjust(10) +
        "OM >=64.5".rjust(11) +
        "CHIRPS >=64.5".rjust(15)
    )
    print("-" * 101)
    for r in results:
        print(
            r["city"].ljust(12) +
            f"{r['n_days']}d".rjust(10) +
            f"{r['correlation_r']:.4f}".rjust(10) +
            f"{r['mean_om_mm']:.2f}".rjust(10) +
            f"{r['mean_chirps_mm']:.2f}".rjust(13) +
            f"{r['mean_bias_mm']:+.2f}".rjust(10) +
            f"{r['mae_mm']:.2f}".rjust(10) +
            str(r["heavy_days_om"]).rjust(11) +
            str(r["heavy_days_chirps"]).rjust(15)
        )

    print("\nSummary Interpretation:")
    for r in results:
        print(f"- {r['city']}: Pearson r = {r['correlation_r']:.3f}, mean bias = {r['mean_bias_mm']:+.2f} mm/day. Heavy rain days (>= 64.5 mm): Open-Meteo ERA5={r['heavy_days_om']}, CHIRPS={r['heavy_days_chirps']}.")

    # Save compact json summary of cross check
    out_path = os.path.join(os.getcwd(), "data", "rainfall_climatology", "chirps_cross_check.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)
    print(f"\n[OK] Cross-check results saved to: {out_path}")

if __name__ == "__main__":
    main()
