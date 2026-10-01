import React, { useState, useRef } from 'react';
import {
  Camera,
  Upload,
  MapPin,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  X,
  ShieldAlert,
} from 'lucide-react';
import {
  CITIZEN_REPORT_CATEGORIES,
  type CitizenReportCategory,
} from '../../types/citizenReport';

interface ReportSubmissionFormProps {
  onReportSubmitted?: () => void;
}

export const ReportSubmissionForm: React.FC<ReportSubmissionFormProps> = ({
  onReportSubmitted,
}) => {
  const [category, setCategory] = useState<CitizenReportCategory>('smoke');
  const [description, setDescription] = useState('');
  const [lat, setLat] = useState('28.6139');
  const [lon, setLon] = useState('77.2090');
  const [honeypot, setHoneypot] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const [locating, setLocating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Client-side advisory validation
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type)) {
      setErrorMessage('Please select a valid JPEG, PNG, or WebP image file.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setErrorMessage('Image file must be under 5 MB.');
      return;
    }

    setErrorMessage(null);
    setSelectedFile(file);
    const objectUrl = URL.createObjectURL(file);
    setPreviewUrl(objectUrl);
  };

  const handleClearFile = () => {
    setSelectedFile(null);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleGetCurrentLocation = () => {
    if (!navigator.geolocation) {
      setErrorMessage('Geolocation is not supported by your browser.');
      return;
    }

    setLocating(true);
    setErrorMessage(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLat(position.coords.latitude.toFixed(6));
        setLon(position.coords.longitude.toFixed(6));
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        setErrorMessage(`Unable to obtain location: ${err.message}`);
      },
      { timeout: 10000, enableHighAccuracy: true }
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setSuccessMessage(null);

    if (!selectedFile) {
      setErrorMessage('Please select a photo of the observed air pollution event.');
      return;
    }

    const parsedLat = parseFloat(lat);
    const parsedLon = parseFloat(lon);
    if (isNaN(parsedLat) || parsedLat < -90 || parsedLat > 90) {
      setErrorMessage('Please enter a valid latitude (-90 to 90).');
      return;
    }
    if (isNaN(parsedLon) || parsedLon < -180 || parsedLon > 180) {
      setErrorMessage('Please enter a valid longitude (-180 to 180).');
      return;
    }

    setSubmitting(true);

    try {
      const formData = new FormData();
      formData.append('photo', selectedFile);
      formData.append('category', category);
      formData.append('description', description.trim());
      formData.append('lat', parsedLat.toString());
      formData.append('lon', parsedLon.toString());
      formData.append('client_timestamp', new Date().toISOString());
      // Honeypot field for anti-bot defense
      formData.append('honeypot', honeypot);

      const resp = await fetch('/api/reports', {
        method: 'POST',
        body: formData,
      });

      const result = await resp.json();

      if (!resp.ok) {
        throw new Error(result.error ?? `Upload failed (${resp.status})`);
      }

      setSuccessMessage(
        result.message ??
          'Report submitted successfully. Observations undergo moderation before public display.'
      );
      handleClearFile();
      setDescription('');
      if (onReportSubmitted) {
        onReportSubmitted();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Submission failed.';
      setErrorMessage(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-surface-card border border-surface-border rounded-xl p-5 sm:p-7 shadow-elevation1 space-y-6"
    >
      <div>
        <div className="flex items-center gap-2 text-brand-600 dark:text-brand-400 font-semibold text-sm">
          <Camera className="w-4 h-4" />
          <span>Submit Ground Observation</span>
        </div>
        <p className="text-xs text-fg-secondary mt-1">
          Upload geotagged evidence of localized smoke, dust, or emissions. All images are
          re-encoded server-side to strip metadata and EXIF location.
        </p>
      </div>

      {/* Honeypot field (hidden from genuine users) */}
      <div className="sr-only" aria-hidden="true">
        <label htmlFor="hp_field">Do not fill this field</label>
        <input
          id="hp_field"
          type="text"
          value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
          tabIndex={-1}
          autoComplete="off"
        />
      </div>

      {/* 1. Category Selection */}
      <div className="space-y-2">
        <label className="block text-xs font-semibold text-fg-primary uppercase tracking-wider">
          Observed Pollution Category *
        </label>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          {CITIZEN_REPORT_CATEGORIES.map((cat) => (
            <button
              key={cat.value}
              type="button"
              onClick={() => setCategory(cat.value)}
              className={`p-3 text-left rounded-lg border transition-all cursor-pointer ${
                category === cat.value
                  ? 'border-brand-500 bg-brand-50 dark:bg-brand-950/40 text-brand-900 dark:text-brand-100 ring-1 ring-brand-500 shadow-sm'
                  : 'border-surface-border bg-surface-subtle hover:bg-surface-hover text-fg-secondary'
              }`}
            >
              <div className="text-xs font-semibold">{cat.label}</div>
              <div className="text-[10px] text-fg-muted mt-0.5 line-clamp-1">
                {cat.description}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* 2. Photo Upload & Preview */}
      <div className="space-y-2">
        <label className="block text-xs font-semibold text-fg-primary uppercase tracking-wider">
          Photo Evidence (JPEG, PNG, WebP &bull; Max 5 MB) *
        </label>

        {previewUrl ? (
          <div className="relative rounded-lg border border-surface-border overflow-hidden bg-surface-subtle max-w-sm">
            <img
              src={previewUrl}
              alt="Observation preview"
              className="w-full h-48 object-cover"
            />
            <button
              type="button"
              onClick={handleClearFile}
              className="absolute top-2 right-2 p-1.5 rounded-full bg-slate-900/80 hover:bg-slate-900 text-white shadow-md transition-colors cursor-pointer"
              aria-label="Remove selected photo"
            >
              <X className="w-4 h-4" />
            </button>
            <div className="p-2 text-[11px] text-fg-muted font-mono flex items-center justify-between border-t border-surface-border bg-surface-card/90">
              <span className="truncate">{selectedFile?.name}</span>
              <span>
                {selectedFile ? `${(selectedFile.size / (1024 * 1024)).toFixed(2)} MB` : ''}
              </span>
            </div>
          </div>
        ) : (
          <div
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-surface-border hover:border-brand-500 hover:bg-surface-hover rounded-xl p-6 text-center transition-colors cursor-pointer flex flex-col items-center justify-center space-y-2"
          >
            <div className="w-10 h-10 rounded-full bg-brand-50 dark:bg-brand-950/40 text-brand-600 dark:text-brand-400 flex items-center justify-center">
              <Upload className="w-5 h-5" />
            </div>
            <div className="text-xs font-medium text-fg-primary">
              Click to select photo or drag and drop
            </div>
            <div className="text-[11px] text-fg-muted">
              Photos are processed, sanitized, and stripped of all EXIF/GPS tags before storage
            </div>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>

      {/* 3. Location Coordinates */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="block text-xs font-semibold text-fg-primary uppercase tracking-wider">
            Observation Location *
          </label>
          <button
            type="button"
            onClick={handleGetCurrentLocation}
            disabled={locating}
            className="inline-flex items-center gap-1.5 text-xs text-brand-600 dark:text-brand-400 hover:underline cursor-pointer disabled:opacity-50"
          >
            {locating ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <MapPin className="w-3.5 h-3.5" />
            )}
            <span>Use My Location</span>
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] text-fg-muted mb-1">Latitude (-90 to 90)</label>
            <input
              type="number"
              step="any"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              required
              className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-surface-border bg-surface-subtle text-fg-primary focus:border-brand-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[11px] text-fg-muted mb-1">Longitude (-180 to 180)</label>
            <input
              type="number"
              step="any"
              value={lon}
              onChange={(e) => setLon(e.target.value)}
              required
              className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-surface-border bg-surface-subtle text-fg-primary focus:border-brand-500 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* 4. Description */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="block text-xs font-semibold text-fg-primary uppercase tracking-wider">
            Short Description (Optional)
          </label>
          <span className="text-[11px] text-fg-muted font-mono">{description.length}/500</span>
        </div>
        <textarea
          rows={3}
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="E.g., Heavy black smoke from waste burning near ring road..."
          className="w-full px-3 py-2 text-xs rounded-lg border border-surface-border bg-surface-subtle text-fg-primary focus:border-brand-500 focus:outline-none placeholder:text-fg-muted resize-none"
        />
      </div>

      {/* Feedback Messages */}
      {errorMessage && (
        <div
          role="alert"
          className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/50 flex items-start gap-2.5 text-xs text-rose-700 dark:text-rose-300"
        >
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{errorMessage}</span>
        </div>
      )}

      {successMessage && (
        <div
          role="status"
          className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 flex items-start gap-2.5 text-xs text-emerald-700 dark:text-emerald-300"
        >
          <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{successMessage}</span>
        </div>
      )}

      {/* Safety Notice */}
      <div className="p-3 rounded-lg bg-surface-subtle border border-surface-border text-[11px] text-fg-muted flex items-start gap-2">
        <ShieldAlert className="w-4 h-4 flex-shrink-0 text-amber-500 mt-0.5" />
        <span>
          <strong>Contextual Observation Only:</strong> Citizen reports undergo automated and
          human moderation before public rendering. To prevent poisoning or bias, citizen
          reports are never ingested into the Phase 1 predictive model or risk algorithms.
        </span>
      </div>

      {/* Submit Button */}
      <button
        type="submit"
        disabled={submitting}
        className="w-full py-2.5 px-4 rounded-lg bg-brand-600 hover:bg-brand-700 text-white font-semibold text-xs transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
      >
        {submitting ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Processing & Sanitizing Upload...</span>
          </>
        ) : (
          <span>Submit Observation for Moderation</span>
        )}
      </button>
    </form>
  );
};
