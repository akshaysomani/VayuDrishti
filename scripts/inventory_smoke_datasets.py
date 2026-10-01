#!/usr/bin/env python3
"""
Read-Only Inventory Script: Local Smoke and Fire Datasets
=========================================================
Strict read-only inspection: does not copy, extract, or modify any files on disk.
Reads archive manifests (ZIP/TAR.GZ) and directory listings in-memory.

Policy:
- Datasets are for local research use only and are NEVER redistributed.
- fire/ contains satellite hotspot data (BHUVAN, NASA FIRMS, MODIS), NOT photos; excluded from triage.
"""

import os
import sys
import zipfile
import tarfile
import xml.etree.ElementTree as ET

def get_dir_file_count(path):
    count = 0
    for root, dirs, files in os.walk(path):
        count += len(files)
    return count

def inspect_dfire(base_dir):
    zip_path = os.path.join(base_dir, 'D-Fire.zip')
    onedrive_path = os.path.join(base_dir, 'OneDrive_2026-09-21.zip')
    
    total_files = 0
    image_formats = {}
    classes_found = set()
    license_status = "NOT FOUND - verify before any use"
    annotation_format = "YOLO format (.txt files with normalized bounding boxes [class_id x y w h])"

    if os.path.exists(zip_path):
        with zipfile.ZipFile(zip_path, 'r') as z:
            names = z.namelist()
            total_files += len(names)
            for n in names:
                lower = n.lower()
                ext = os.path.splitext(lower)[1]
                if ext in ('.jpg', '.jpeg', '.png', '.webp'):
                    image_formats[ext] = image_formats.get(ext, 0) + 1
                elif 'license' in lower or 'readme' in lower:
                    license_status = f"found: {n}"

            # Scan a subset of label txts to identify class indices
            for n in names:
                if n.endswith('.txt') and 'labels' in n:
                    try:
                        content = z.read(n).decode('utf-8', errors='ignore')
                        for line in content.splitlines():
                            parts = line.strip().split()
                            if parts:
                                classes_found.add(parts[0])
                        if len(classes_found) >= 2:
                            break
                    except Exception:
                        pass

    # In D-Fire convention: 0 = smoke, 1 = fire, empty txt = clean/no fire/no smoke
    class_names = []
    if '0' in classes_found: class_names.append("0: smoke")
    if '1' in classes_found: class_names.append("1: fire")
    class_names.append("(empty .txt: clear_normal/no-fire background)")

    if os.path.exists(onedrive_path):
        with zipfile.ZipFile(onedrive_path, 'r') as z:
            total_files += len(z.namelist())

    return {
        "dataset_name": "D-Fire",
        "total_files": total_files,
        "image_formats": image_formats,
        "annotation_format": annotation_format,
        "classes_found": class_names,
        "license_status": license_status,
        "storage": "Compressed archive (D-Fire.zip, OneDrive_2026-09-21.zip)"
    }

def inspect_datacluster(base_dir):
    zip_path = os.path.join(base_dir, 'archive.zip')
    total_files = 0
    image_formats = {}
    classes_found = set()
    license_status = "NOT FOUND - verify before any use"
    annotation_format = "Pascal VOC XML format (.xml files with object name & bndbox)"

    if os.path.exists(zip_path):
        with zipfile.ZipFile(zip_path, 'r') as z:
            names = z.namelist()
            total_files += len(names)
            for n in names:
                lower = n.lower()
                ext = os.path.splitext(lower)[1]
                if ext in ('.jpg', '.jpeg', '.png', '.webp'):
                    image_formats[ext] = image_formats.get(ext, 0) + 1
                elif 'license' in lower or 'readme' in lower:
                    license_status = f"found: {n}"
                elif n.endswith('.xml'):
                    try:
                        tree = ET.fromstring(z.read(n))
                        for obj in tree.findall('object'):
                            name_el = obj.find('name')
                            if name_el is not None and name_el.text:
                                classes_found.add(name_el.text.strip())
                    except Exception:
                        pass

    return {
        "dataset_name": "DataCluster Fire & Smoke Dataset (Kaggle)",
        "total_files": total_files,
        "image_formats": image_formats,
        "annotation_format": annotation_format,
        "classes_found": sorted(list(classes_found)),
        "license_status": license_status,
        "storage": "Compressed archive (archive.zip)"
    }

def inspect_ai_for_mankind(base_dir):
    tar_path = os.path.join(base_dir, 'cloud.tar.gz')
    total_files = 0
    image_formats = {}
    license_status = "NOT FOUND - verify before any use"
    annotation_format = "Folder structure / image filenames (Wildfire smoke camera captures)"

    if os.path.exists(tar_path):
        with tarfile.open(tar_path, 'r:gz') as t:
            names = t.getnames()
            total_files += len(names)
            for n in names:
                lower = n.lower()
                ext = os.path.splitext(lower)[1]
                if ext in ('.jpg', '.jpeg', '.png', '.webp'):
                    image_formats[ext] = image_formats.get(ext, 0) + 1
                elif 'license' in lower or 'readme' in lower:
                    license_status = f"found: {n}"

    return {
        "dataset_name": "AI for Mankind — Wildfire Smoke Dataset",
        "total_files": total_files,
        "image_formats": image_formats,
        "annotation_format": annotation_format,
        "classes_found": ["smoke (wildfire plumes against sky/mountains)"],
        "license_status": license_status,
        "storage": "Compressed archive (cloud.tar.gz)"
    }

def inspect_fire_dir(fire_dir):
    inventory = []
    if not os.path.exists(fire_dir):
        return inventory
    for name in os.listdir(fire_dir):
        sub = os.path.join(fire_dir, name)
        if os.path.isdir(sub):
            file_types = {}
            total = 0
            for root, dirs, files in os.walk(sub):
                total += len(files)
                for f in files:
                    ext = os.path.splitext(f.lower())[1] or 'no_ext'
                    file_types[ext] = file_types.get(ext, 0) + 1
            inventory.append({
                "source_name": name,
                "total_files": total,
                "file_types": file_types,
                "nature": "Satellite / geospatial hotspot data (NOT photos)",
                "triage_eligibility": "EXCLUDED (contains no photos)"
            })
    return inventory

def main():
    root = os.getcwd()
    smoke_dir = os.path.join(root, 'smoke')
    fire_dir = os.path.join(root, 'fire')

    print("=" * 70)
    print("VAYUDRISHTI LOCAL DATASET READ-ONLY INVENTORY")
    print("=" * 70)
    print("NOTICE: These datasets are for local research use only and are NEVER redistributed.\n")

    # 1. Smoke Datasets
    print("--- 1. SMOKE / WILDFIRE PHOTO DATASETS (smoke/) ---")
    smoke_datasets = []
    for item in os.listdir(smoke_dir):
        full = os.path.join(smoke_dir, item)
        if not os.path.isdir(full):
            continue
        if 'd-fire' in item.lower():
            smoke_datasets.append(inspect_dfire(full))
        elif 'datacluster' in item.lower():
            smoke_datasets.append(inspect_datacluster(full))
        elif 'mankind' in item.lower():
            smoke_datasets.append(inspect_ai_for_mankind(full))
        else:
            smoke_datasets.append({
                "dataset_name": item,
                "total_files": get_dir_file_count(full),
                "image_formats": {},
                "annotation_format": "Unknown",
                "classes_found": [],
                "license_status": "NOT FOUND - verify before any use",
                "storage": "Local directory"
            })

    for ds in smoke_datasets:
        print(f"\nDataset: {ds['dataset_name']}")
        print(f"  Storage:            {ds['storage']}")
        print(f"  Total Files/Entries:{ds['total_files']}")
        print(f"  Image Formats:      {ds['image_formats']}")
        print(f"  Annotation Format:  {ds['annotation_format']}")
        print(f"  Classes Found:      {', '.join(ds['classes_found'])}")
        print(f"  License Status:     {ds['license_status']}")

    # 2. Fire Directory Exclusions
    print("\n" + "-" * 70)
    print("--- 2. GEOSPATIAL / SATELLITE FIRE DATA (fire/) ---")
    print("Policy: Excluded from citizen report triage. Contains geospatial coordinates only.")
    fire_items = inspect_fire_dir(fire_dir)
    for fi in fire_items:
        print(f"\nSubdirectory: {fi['source_name']}")
        print(f"  Total Files:        {fi['total_files']}")
        print(f"  File Types:         {fi['file_types']}")
        print(f"  Data Nature:        {fi['nature']}")
        print(f"  Triage Status:      {fi['triage_eligibility']}")

    print("\n" + "=" * 70)
    print("INVENTORY SCAN COMPLETE (Read-Only, Zero Mutations)")
    print("=" * 70)

if __name__ == '__main__':
    main()
