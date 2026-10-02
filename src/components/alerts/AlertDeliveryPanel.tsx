import React, { useState, useEffect, useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import {
  Send,
  Radio,
  ShieldCheck,
  Clock,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RefreshCw,
  Key,
  Lock,
  Unlock,
  Plus,
  Mail,
  Webhook,
  Activity,
  Trash2,
} from 'lucide-react';
import type {
  AlertDeliveryStats,
  AlertDeliveryRecord,
  RecipientRecord,
  StationCooldownState,
  AlertMinTier,
  RecipientScopeType,
} from '../../types/alertDelivery';

gsap.registerPlugin(useGSAP);

export const AlertDeliveryPanel: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  // Public stats state (strictly minimized, 0 recipient destination text)
  const [stats, setStats] = useState<AlertDeliveryStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);

  // In-memory admin state ONLY (never persisted to localStorage or sessionStorage)
  const [adminToken, setAdminToken] = useState<string>('');
  const [isAdminUnlocked, setIsAdminUnlocked] = useState<boolean>(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [adminSuccess, setAdminSuccess] = useState<string | null>(null);

  // Admin data
  const [recipients, setRecipients] = useState<RecipientRecord[]>([]);
  const [adminDeliveries, setAdminDeliveries] = useState<AlertDeliveryRecord[]>([]);
  const [loadingRecipients, setLoadingRecipients] = useState<boolean>(false);
  const [triggeringDispatch, setTriggeringDispatch] = useState<boolean>(false);

  // Add Recipient form state
  const [newRecipientName, setNewRecipientName] = useState('');
  const [newRecipientChannel, setNewRecipientChannel] = useState<'email' | 'webhook'>('webhook');
  const [newRecipientDestination, setNewRecipientDestination] = useState('');
  const [newRecipientScopeType, setNewRecipientScopeType] = useState<RecipientScopeType>('all');
  const [newRecipientScopeValue, setNewRecipientScopeValue] = useState('');
  const [newRecipientMinTier, setNewRecipientMinTier] = useState<AlertMinTier>('ELEVATED');
  const [isSubmittingRecipient, setIsSubmittingRecipient] = useState(false);

  // Test Alert state
  const [testRecipientId, setTestRecipientId] = useState('');
  const [testStationId, setTestStationId] = useState('DL001');
  const [isSendingTest, setIsSendingTest] = useState(false);

  const fetchStats = async () => {
    setLoadingStats(true);
    setStatsError(null);
    try {
      const res = await fetch('/api/alerts/delivery/stats');
      if (!res.ok) {
        throw new Error(`Failed to load delivery stats (${res.status})`);
      }
      const data: AlertDeliveryStats = await res.json();
      setStats(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error loading delivery status.';
      setStatsError(msg);
    } finally {
      setLoadingStats(false);
    }
  };

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 30000);
    return () => clearInterval(interval);
  }, []);

  // Admin token verification, recipient fetching, and detailed audit trail
  const unlockAdmin = async (tokenToVerify?: string) => {
    const activeToken = tokenToVerify ?? adminToken;
    if (!activeToken.trim()) {
      setAdminError('Please provide an alert admin token.');
      return;
    }
    setLoadingRecipients(true);
    setAdminError(null);
    setAdminSuccess(null);
    try {
      // 1. Fetch recipients
      const resRecipients = await fetch('/api/alerts/delivery/admin/recipients', {
        headers: {
          Authorization: `Bearer ${activeToken.trim()}`,
        },
      });

      if (!resRecipients.ok) {
        if (resRecipients.status === 401 || resRecipients.status === 429 || resRecipients.status === 503) {
          setIsAdminUnlocked(false);
          const errData = await resRecipients.json().catch(() => ({}));
          throw new Error(errData.error || `Authentication failed (${resRecipients.status}).`);
        }
        throw new Error(`Failed to fetch admin recipients (${resRecipients.status})`);
      }

      const dataRecipients = await resRecipients.json();
      setRecipients(dataRecipients.recipients || []);

      // 2. Fetch admin detailed deliveries audit trail
      try {
        const resDeliveries = await fetch('/api/alerts/delivery/admin/deliveries?limit=25', {
          headers: {
            Authorization: `Bearer ${activeToken.trim()}`,
          },
        });
        if (resDeliveries.ok) {
          const dataDeliveries = await resDeliveries.json();
          setAdminDeliveries(dataDeliveries.deliveries || []);
        }
      } catch {
        // Non-blocking for admin unlock
      }

      setIsAdminUnlocked(true);
      setAdminSuccess('Admin credentials verified. Token held in volatile memory only.');
      if (dataRecipients.recipients?.length > 0 && !testRecipientId) {
        setTestRecipientId(dataRecipients.recipients[0].id);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error validating admin token.';
      setAdminError(msg);
      setIsAdminUnlocked(false);
    } finally {
      setLoadingRecipients(false);
    }
  };

  const handleLockAdmin = () => {
    setAdminToken('');
    setIsAdminUnlocked(false);
    setRecipients([]);
    setAdminDeliveries([]);
    setAdminError(null);
    setAdminSuccess(null);
  };

  const handleAddRecipient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminToken) return;
    setIsSubmittingRecipient(true);
    setAdminError(null);
    setAdminSuccess(null);

    try {
      const res = await fetch('/api/alerts/delivery/admin/recipients', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken.trim()}`,
        },
        body: JSON.stringify({
          name: newRecipientName.trim(),
          channel: newRecipientChannel,
          destination: newRecipientDestination.trim(),
          scope_type: newRecipientScopeType,
          scope_value: newRecipientScopeType !== 'all' ? newRecipientScopeValue.trim() : null,
          min_tier: newRecipientMinTier,
          active: true,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Failed to add recipient (${res.status})`);
      }

      setAdminSuccess('Recipient added successfully to database.');
      setNewRecipientName('');
      setNewRecipientDestination('');
      setNewRecipientScopeValue('');
      await unlockAdmin();
    } catch (err: unknown) {
      setAdminError(err instanceof Error ? err.message : 'Failed to create recipient');
    } finally {
      setIsSubmittingRecipient(false);
    }
  };

  const handleToggleRecipientActive = async (id: string, currentActive: boolean) => {
    if (!adminToken) return;
    try {
      const res = await fetch(`/api/alerts/delivery/admin/recipients/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken.trim()}`,
        },
        body: JSON.stringify({ active: !currentActive }),
      });
      if (!res.ok) {
        throw new Error('Failed to update recipient status');
      }
      setAdminSuccess(`Recipient ${!currentActive ? 'activated' : 'deactivated'} successfully.`);
      await unlockAdmin();
    } catch (err: unknown) {
      setAdminError(err instanceof Error ? err.message : 'Update failed');
    }
  };

  const handleDeleteRecipient = async (id: string, name: string) => {
    if (!adminToken) return;
    if (!window.confirm(`Are you sure you want to soft-delete recipient "${name}"? The audit log will be preserved, but this recipient will no longer receive alerts.`)) {
      return;
    }
    try {
      const res = await fetch(`/api/alerts/delivery/admin/recipients/${id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${adminToken.trim()}`,
        },
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Failed to delete recipient (${res.status})`);
      }
      setAdminSuccess(`Recipient "${name}" soft-deleted successfully.`);
      await unlockAdmin();
    } catch (err: unknown) {
      setAdminError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const handleSendTestAlert = async () => {
    if (!adminToken || !testRecipientId) return;
    setIsSendingTest(true);
    setAdminError(null);
    setAdminSuccess(null);

    try {
      const res = await fetch('/api/alerts/delivery/admin/test-alert', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken.trim()}`,
        },
        body: JSON.stringify({
          recipient_id: testRecipientId,
          station_id: testStationId,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to dispatch test alert');
      }

      setAdminSuccess(
        `Test alert dispatched directly: ${data.message || 'Delivered successfully.'} (Clearly marked [TEST ALERT] and excluded from real counts).`
      );
      fetchStats();
    } catch (err: unknown) {
      setAdminError(err instanceof Error ? err.message : 'Test dispatch failed');
    } finally {
      setIsSendingTest(false);
    }
  };

  const handleTriggerDispatch = async () => {
    if (!adminToken) return;
    setTriggeringDispatch(true);
    setAdminError(null);
    setAdminSuccess(null);

    try {
      const res = await fetch('/api/alerts/delivery/admin/dispatch-now', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken.trim()}`,
        },
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Manual dispatch failed');
      }

      setAdminSuccess(`Dispatcher sweep completed. Processed: ${data.processed_count ?? 0} outbox records.`);
      fetchStats();
    } catch (err: unknown) {
      setAdminError(err instanceof Error ? err.message : 'Dispatcher sweep failed');
    } finally {
      setTriggeringDispatch(false);
    }
  };

  // Subtle GSAP entrance animation with prefers-reduced-motion check
  useGSAP(
    () => {
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (prefersReducedMotion) {
        gsap.set('.delivery-panel-card', { opacity: 1, y: 0 });
        return;
      }

      gsap.fromTo(
        '.delivery-panel-card',
        { opacity: 0, y: 12 },
        {
          opacity: 1,
          y: 0,
          duration: 0.3,
          ease: 'power2.out',
          clearProps: 'transform',
        }
      );
    },
    { dependencies: [isAdminUnlocked], scope: containerRef }
  );

  const isDryRun = stats?.mode === 'dry_run';
  const cooldownList: StationCooldownState[] = stats?.cooldowns ? Object.values(stats.cooldowns) : [];

  return (
    <div
      ref={containerRef}
      className="bg-surface-card border border-surface-border rounded-xl p-5 sm:p-7 shadow-elevation2 space-y-6"
    >
      {/* 1. Header & Delivery Mode Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-surface-border pb-5">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-400">
            <Radio className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base sm:text-lg font-bold text-fg-primary">
                Authority Alert Delivery (Phase 5 f4)
              </h2>
              <span
                className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full border ${
                  isDryRun
                    ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
                    : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
                }`}
              >
                {isDryRun ? 'DRY-RUN MODE' : 'LIVE DISPATCH MODE'}
              </span>
            </div>
            <p className="text-xs text-fg-secondary mt-0.5">
              Automated high-risk acute spike alerts to municipal environment departments and pollution control boards.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          <button
            type="button"
            onClick={fetchStats}
            disabled={loadingStats}
            aria-label="Refresh delivery status"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-subtle hover:bg-surface-hover border border-surface-border text-xs font-medium text-fg-secondary hover:text-fg-primary transition-colors cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingStats ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Mode Advisory Notice */}
      <div
        className={`p-3.5 rounded-lg border text-xs leading-relaxed flex items-start gap-2.5 ${
          isDryRun
            ? 'bg-amber-500/10 border-amber-500/25 text-amber-800 dark:text-amber-300'
            : 'bg-emerald-500/10 border-emerald-500/25 text-emerald-800 dark:text-emerald-300'
        }`}
      >
        <ShieldCheck className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <div>
          {isDryRun ? (
            <p>
              <strong>Safety Guard Active (dry_run):</strong> High-risk acute spike alerts are logged to the PostgreSQL outbox
              with full deduplication, escalation bypass, and cooldown checks, but zero external webhooks or emails are sent.
            </p>
          ) : (
            <p>
              <strong>Live Transmission Active:</strong> High-risk acute spike alerts are actively dispatched to configured recipients
              via authenticated webhooks and TLS email.
            </p>
          )}
        </div>
      </div>

      {statsError && (
        <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>{statsError}</span>
        </div>
      )}

      {/* 2. Key Metrics Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="p-3 rounded-lg bg-surface-subtle border border-surface-border">
          <div className="text-[11px] font-medium text-fg-secondary">Pending Queue</div>
          <div className="text-xl font-bold font-mono text-fg-primary mt-1">
            {stats?.counts_by_status?.PENDING ?? 0}
          </div>
          <div className="text-[10px] text-fg-secondary">Awaiting dispatch</div>
        </div>
        <div className="p-3 rounded-lg bg-surface-subtle border border-surface-border">
          <div className="text-[11px] font-medium text-fg-secondary">Sent (Live)</div>
          <div className="text-xl font-bold font-mono text-emerald-600 dark:text-emerald-400 mt-1">
            {stats?.counts_by_status?.SENT ?? 0}
          </div>
          <div className="text-[10px] text-fg-secondary">External deliveries</div>
        </div>
        <div className="p-3 rounded-lg bg-surface-subtle border border-surface-border">
          <div className="text-[11px] font-medium text-fg-secondary">Simulated (Dry Run)</div>
          <div className="text-xl font-bold font-mono text-amber-600 dark:text-amber-400 mt-1">
            {stats?.counts_by_status?.DRY_RUN ?? 0}
          </div>
          <div className="text-[10px] text-fg-secondary">Logged without send</div>
        </div>
        <div className="p-3 rounded-lg bg-surface-subtle border border-surface-border">
          <div className="text-[11px] font-medium text-fg-secondary">Expired (Stale)</div>
          <div className="text-xl font-bold font-mono text-slate-500 dark:text-slate-400 mt-1">
            {stats?.counts_by_status?.EXPIRED ?? 0}
          </div>
          <div className="text-[10px] text-fg-secondary">Exceeded max age</div>
        </div>
        <div className="p-3 rounded-lg bg-surface-subtle border border-surface-border">
          <div className="text-[11px] font-medium text-fg-secondary">Failed / Dead</div>
          <div className="text-xl font-bold font-mono text-rose-600 dark:text-rose-400 mt-1">
            {(stats?.counts_by_status?.FAILED ?? 0) + (stats?.counts_by_status?.DEAD ?? 0)}
          </div>
          <div className="text-[10px] text-fg-secondary">
            {stats?.counts_by_status?.DEAD ?? 0} dead-lettered
          </div>
        </div>
        <div className="p-3 rounded-lg bg-surface-subtle border border-surface-border col-span-2 sm:col-span-1">
          <div className="text-[11px] font-medium text-fg-secondary">Active Recipients</div>
          <div className="text-xl font-bold font-mono text-brand-600 dark:text-brand-400 mt-1">
            {stats?.active_recipients ?? 0}
          </div>
          <div className="text-[10px] text-fg-secondary">Configured in DB</div>
        </div>
      </div>

      {/* 3. Station Cooldown Status */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-secondary flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />
            <span>Station Cooldown State (Policy: 6h Cooldown, Escalation Bypasses)</span>
          </h3>
          <span className="text-[11px] font-mono text-fg-secondary">
            Dispatcher: <strong className="text-fg-primary">{stats?.is_dispatcher_running ? 'Worker Active' : 'Idle'}</strong>
          </span>
        </div>

        {cooldownList.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {cooldownList.map((st) => (
              <div
                key={st.station_id}
                className="p-3 rounded-lg border border-surface-border bg-surface-subtle flex flex-col justify-between text-xs space-y-1.5"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-fg-primary truncate max-w-[160px]">
                    {st.station_id.replace(/_/g, ' ')}
                  </span>
                  <span
                    className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${
                      st.in_cooldown
                        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                        : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                    }`}
                  >
                    {st.in_cooldown ? 'IN COOLDOWN' : 'READY TO ALERT'}
                  </span>
                </div>
                <div className="text-[11px] text-fg-secondary flex items-center justify-between">
                  <span>Last Alert Tier:</span>
                  <span className="font-mono font-semibold text-fg-primary">
                    {st.last_alerted_tier ?? 'None'}
                  </span>
                </div>
                {st.in_cooldown && st.cooldown_expires_at && (
                  <div className="text-[10px] text-fg-secondary font-mono">
                    Expires: {new Date(st.cooldown_expires_at).toLocaleTimeString()}
                    <span className="text-brand-600 dark:text-brand-400 ml-1">
                      (High tier bypasses)
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="p-4 rounded-lg bg-surface-subtle border border-surface-border text-xs text-fg-secondary text-center">
            No station alert history recorded yet in PostgreSQL.
          </div>
        )}
      </div>

      {/* 4. Recent Deliveries Audit Trail (Public View: Minimized, Zero Destination Text) */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-secondary flex items-center gap-1.5">
          <Activity className="w-3.5 h-3.5" />
          <span>Recent Dispatch Audit Log</span>
        </h3>

        {stats?.recent_deliveries && stats.recent_deliveries.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border border-surface-border">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-subtle text-fg-secondary uppercase text-[10px] font-mono border-b border-surface-border">
                <tr>
                  <th className="px-3 py-2">Timestamp</th>
                  <th className="px-3 py-2">Channel</th>
                  <th className="px-3 py-2">Station</th>
                  <th className="px-3 py-2">Tier</th>
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border font-mono text-[11px]">
                {stats.recent_deliveries.map((del, idx) => (
                  <tr key={`${del.timestamp}-${del.channel}-${del.station}-${idx}`} className="hover:bg-surface-subtle/50 transition-colors">
                    <td className="px-3 py-2 text-fg-secondary whitespace-nowrap">
                      {new Date(del.timestamp).toLocaleTimeString()}
                    </td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1">
                        {del.channel === 'webhook' ? (
                          <Webhook className="w-3 h-3 text-brand-500" />
                        ) : (
                          <Mail className="w-3 h-3 text-sky-500" />
                        )}
                        <span className="capitalize">{del.channel}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2 text-fg-primary">
                      {del.station}
                    </td>
                    <td className="px-3 py-2">
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-surface-subtle border border-surface-border text-fg-secondary">
                        {del.tier}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                          del.status === 'SENT'
                            ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                            : del.status === 'DRY_RUN'
                            ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                            : del.status === 'EXPIRED'
                            ? 'bg-slate-500/15 text-slate-600 dark:text-slate-400 border border-slate-500/30'
                            : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
                        }`}
                      >
                        {del.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-4 rounded-lg bg-surface-subtle border border-surface-border text-xs text-fg-secondary text-center">
            No delivery audit logs recorded yet.
          </div>
        )}
      </div>

      {/* 5. ADMIN CONTROL CONSOLE (Token Held Strictly in In-Memory State) */}
      <div className="pt-4 border-t border-surface-border space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Key className="w-4 h-4 text-brand-500" />
            <h3 className="text-sm font-bold text-fg-primary">
              Authority Delivery Admin Console
            </h3>
            {isAdminUnlocked ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-mono text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                <Unlock className="w-3 h-3" /> Unlocked (In-Memory)
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[11px] font-mono text-fg-secondary bg-surface-subtle px-2 py-0.5 rounded-full border border-surface-border">
                <Lock className="w-3 h-3" /> Locked
              </span>
            )}
          </div>

          {isAdminUnlocked && (
            <button
              type="button"
              onClick={handleLockAdmin}
              className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-surface-subtle hover:bg-surface-hover border border-surface-border text-xs font-medium text-fg-secondary hover:text-fg-primary transition-colors cursor-pointer"
            >
              <Lock className="w-3.5 h-3.5" />
              <span>Lock Console</span>
            </button>
          )}
        </div>

        {/* Admin Feedback Messages */}
        {adminError && (
          <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-xs flex items-center gap-2">
            <XCircle className="w-4 h-4 flex-shrink-0" />
            <span>{adminError}</span>
          </div>
        )}

        {adminSuccess && (
          <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            <span>{adminSuccess}</span>
          </div>
        )}

        {!isAdminUnlocked ? (
          /* Authentication Form */
          <div className="p-4 rounded-xl border border-surface-border bg-surface-subtle/50 space-y-3">
            <p className="text-xs text-fg-secondary">
              Recipient management, manual queue dispatching, and live test simulations require the
              server-side <code className="font-mono text-fg-primary">ALERT_ADMIN_TOKEN</code>.
              The token is validated via constant-time comparison and stored strictly in browser memory.
            </p>
            <div className="flex flex-col sm:flex-row items-center gap-2">
              <input
                type="password"
                placeholder="Enter ALERT_ADMIN_TOKEN..."
                value={adminToken}
                onChange={(e) => setAdminToken(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && unlockAdmin()}
                className="w-full sm:w-80 px-3 py-2 rounded-lg bg-surface-card border border-surface-border text-xs text-fg-primary placeholder-fg-secondary focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
              />
              <button
                type="button"
                onClick={() => unlockAdmin()}
                disabled={loadingRecipients || !adminToken.trim()}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50"
              >
                {loadingRecipients ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Unlock className="w-3.5 h-3.5" />
                )}
                <span>Authenticate Admin</span>
              </button>
            </div>
          </div>
        ) : (
          /* Unlocked Admin Operations */
          <div className="space-y-6 delivery-panel-card">
            {/* Action Bar */}
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleTriggerDispatch}
                disabled={triggeringDispatch}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${triggeringDispatch ? 'animate-spin' : ''}`} />
                <span>Trigger Dispatcher Sweep</span>
              </button>

              <button
                type="button"
                onClick={() => unlockAdmin()}
                disabled={loadingRecipients}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-subtle hover:bg-surface-hover border border-surface-border text-xs font-medium text-fg-primary transition-colors cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingRecipients ? 'animate-spin' : ''}`} />
                <span>Reload Recipients</span>
              </button>
            </div>

            {/* Recipient Management List */}
            <div className="space-y-3">
              <h4 className="text-xs font-bold text-fg-primary uppercase font-mono tracking-wider">
                Configured Authority Recipients ({recipients.length})
              </h4>
              {recipients.length > 0 ? (
                <div className="divide-y divide-surface-border rounded-lg border border-surface-border overflow-hidden">
                  {recipients.map((r) => (
                    <div
                      key={r.id}
                      className="p-3 bg-surface-card flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-fg-primary">{r.name}</span>
                          <span className="inline-flex items-center gap-1 font-mono text-[10px] px-1.5 py-0.5 rounded bg-surface-subtle border border-surface-border text-fg-secondary">
                            {r.channel === 'webhook' ? (
                              <Webhook className="w-2.5 h-2.5 text-brand-500" />
                            ) : (
                              <Mail className="w-2.5 h-2.5 text-sky-500" />
                            )}
                            {r.channel}
                          </span>
                          <span
                            className={`text-[10px] font-mono px-1.5 py-0.2 rounded font-semibold ${
                              r.active
                                ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                                : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
                            }`}
                          >
                            {r.active ? 'ACTIVE' : 'INACTIVE'}
                          </span>
                        </div>
                        <div className="text-[11px] font-mono text-fg-secondary truncate max-w-md">
                          Destination: <strong className="text-fg-primary">{r.destination}</strong>
                        </div>
                        <div className="text-[10px] text-fg-secondary font-mono">
                          Scope: {r.scope_type} {r.scope_value ? `(${r.scope_value})` : ''} | Min Tier: {r.min_tier || 'ELEVATED'}
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleToggleRecipientActive(r.id, r.active)}
                          className="px-2.5 py-1 rounded bg-surface-subtle hover:bg-surface-hover border border-surface-border text-[11px] text-fg-secondary hover:text-fg-primary transition-colors cursor-pointer"
                        >
                          {r.active ? 'Deactivate' : 'Activate'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteRecipient(r.id, r.name)}
                          title="Soft-delete recipient"
                          aria-label={`Soft-delete recipient ${r.name}`}
                          className="p-1 rounded bg-surface-subtle hover:bg-rose-500/10 border border-surface-border hover:border-rose-500/30 text-fg-secondary hover:text-rose-600 dark:hover:text-rose-400 transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-4 rounded-lg bg-surface-subtle border border-surface-border text-xs text-fg-secondary text-center">
                  No authority recipients configured in the database yet. Add one below.
                </div>
              )}
            </div>

            {/* Add Recipient Form */}
            <form
              onSubmit={handleAddRecipient}
              className="p-4 rounded-xl border border-surface-border bg-surface-subtle/40 space-y-4"
            >
              <h4 className="text-xs font-bold text-fg-primary uppercase font-mono tracking-wider flex items-center gap-1.5">
                <Plus className="w-3.5 h-3.5 text-brand-500" />
                <span>Register Authority Recipient</span>
              </h4>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-fg-secondary">Authority Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. DPCC Emergency Operations"
                    value={newRecipientName}
                    onChange={(e) => setNewRecipientName(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg bg-surface-card border border-surface-border text-xs text-fg-primary focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-fg-secondary">Channel</label>
                  <select
                    value={newRecipientChannel}
                    onChange={(e) => setNewRecipientChannel(e.target.value as 'email' | 'webhook')}
                    className="w-full px-3 py-1.5 rounded-lg bg-surface-card border border-surface-border text-xs text-fg-primary focus:outline-none focus:ring-1 focus:ring-brand-500"
                  >
                    <option value="webhook">Webhook (POST JSON + HMAC)</option>
                    <option value="email">Email (SMTP TLS)</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-fg-secondary">
                    {newRecipientChannel === 'webhook' ? 'Webhook URL (https://...)' : 'Email Address'}
                  </label>
                  <input
                    type={newRecipientChannel === 'webhook' ? 'url' : 'email'}
                    required
                    placeholder={
                      newRecipientChannel === 'webhook'
                        ? 'https://api.authority.gov.in/alerts'
                        : 'alerts@cpcb.nic.in'
                    }
                    value={newRecipientDestination}
                    onChange={(e) => setNewRecipientDestination(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg bg-surface-card border border-surface-border text-xs text-fg-primary focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-fg-secondary">Scope Type</label>
                  <select
                    value={newRecipientScopeType}
                    onChange={(e) => setNewRecipientScopeType(e.target.value as RecipientScopeType)}
                    className="w-full px-3 py-1.5 rounded-lg bg-surface-card border border-surface-border text-xs text-fg-primary focus:outline-none focus:ring-1 focus:ring-brand-500"
                  >
                    <option value="all">All Stations (Nationwide / System-wide)</option>
                    <option value="city">Specific City</option>
                    <option value="station">Specific Station</option>
                  </select>
                </div>

                {newRecipientScopeType !== 'all' && (
                  <div className="space-y-1">
                    <label className="text-[11px] font-medium text-fg-secondary">
                      {newRecipientScopeType === 'city' ? 'City Name' : 'Station ID'}
                    </label>
                    <input
                      type="text"
                      required
                      placeholder={newRecipientScopeType === 'city' ? 'e.g. Delhi' : 'e.g. DL001'}
                      value={newRecipientScopeValue}
                      onChange={(e) => setNewRecipientScopeValue(e.target.value)}
                      className="w-full px-3 py-1.5 rounded-lg bg-surface-card border border-surface-border text-xs text-fg-primary focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
                    />
                  </div>
                )}

                <div className="space-y-1">
                  <label className="text-[11px] font-medium text-fg-secondary">Minimum Risk Tier</label>
                  <select
                    value={newRecipientMinTier}
                    onChange={(e) => setNewRecipientMinTier(e.target.value as AlertMinTier)}
                    className="w-full px-3 py-1.5 rounded-lg bg-surface-card border border-surface-border text-xs text-fg-primary focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
                  >
                    <option value="ELEVATED">ELEVATED (p &ge; 0.22 - Recommended)</option>
                    <option value="HIGH">HIGH (p &ge; 0.50 - Severe only)</option>
                    <option value="WATCH">WATCH (p &ge; 0.05)</option>
                  </select>
                </div>
              </div>

              <button
                type="submit"
                disabled={isSubmittingRecipient}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50"
              >
                {isSubmittingRecipient ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Plus className="w-3.5 h-3.5" />
                )}
                <span>Save Recipient to PostgreSQL</span>
              </button>
            </form>

            {/* Send TEST Alert Form */}
            <div className="p-4 rounded-xl border border-surface-border bg-surface-subtle/40 space-y-3">
              <h4 className="text-xs font-bold text-fg-primary uppercase font-mono tracking-wider flex items-center gap-1.5">
                <Send className="w-3.5 h-3.5 text-sky-500" />
                <span>Simulate Immediate Test Alert (Marked [TEST ALERT])</span>
              </h4>
              <p className="text-xs text-fg-secondary">
                Dispatches a synthetic alert clearly labeled <strong className="text-fg-primary">[TEST ALERT]</strong> to verify
                channel connectivity, SSL certificates, and HMAC signature validation without altering genuine alert metrics.
              </p>

              <div className="flex flex-col sm:flex-row items-center gap-3">
                <select
                  value={testRecipientId}
                  onChange={(e) => setTestRecipientId(e.target.value)}
                  className="w-full sm:w-72 px-3 py-2 rounded-lg bg-surface-card border border-surface-border text-xs text-fg-primary focus:outline-none focus:ring-1 focus:ring-brand-500"
                >
                  <option value="">Select Recipient...</option>
                  {recipients.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.channel}: {r.destination})
                    </option>
                  ))}
                </select>

                <select
                  value={testStationId}
                  onChange={(e) => setTestStationId(e.target.value)}
                  className="w-full sm:w-60 px-3 py-2 rounded-lg bg-surface-card border border-surface-border text-xs text-fg-primary focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
                >
                  <option value="DL001">Delhi - Anand Vihar (DL001)</option>
                  <option value="DL002">Delhi - Punjabi Bagh (DL002)</option>
                  <option value="MH001">Mumbai - Bandra (MH001)</option>
                  <option value="WB001">Kolkata - Victoria (WB001)</option>
                </select>

                <button
                  type="button"
                  onClick={handleSendTestAlert}
                  disabled={isSendingTest || !testRecipientId}
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50"
                >
                  {isSendingTest ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Send className="w-3.5 h-3.5" />
                  )}
                  <span>Send Test Alert</span>
                </button>
              </div>
            </div>

            {/* Admin Detailed Delivery Audit Log (Visible Only When Unlocked) */}
            <div className="space-y-3 pt-2 border-t border-surface-border">
              <h4 className="text-xs font-bold text-fg-primary uppercase font-mono tracking-wider flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5 text-brand-500" />
                <span>Admin Detailed Delivery Audit Log ({adminDeliveries.length})</span>
              </h4>
              <p className="text-xs text-fg-secondary">
                Protected audit log showing recipient identity and masked delivery addresses.
              </p>

              {adminDeliveries.length > 0 ? (
                <div className="overflow-x-auto rounded-lg border border-surface-border">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-surface-subtle text-fg-secondary uppercase text-[10px] font-mono border-b border-surface-border">
                      <tr>
                        <th className="px-3 py-2">Timestamp</th>
                        <th className="px-3 py-2">Recipient</th>
                        <th className="px-3 py-2">Channel</th>
                        <th className="px-3 py-2">Destination</th>
                        <th className="px-3 py-2">Status</th>
                        <th className="px-3 py-2">Provider Response</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-border font-mono text-[11px]">
                      {adminDeliveries.map((del) => (
                        <tr key={del.id} className="hover:bg-surface-subtle/50 transition-colors">
                          <td className="px-3 py-2 text-fg-secondary whitespace-nowrap">
                            {new Date(del.delivered_at).toLocaleTimeString()}
                          </td>
                          <td className="px-3 py-2 text-fg-primary font-medium">
                            {recipients.find((r) => r.id === del.recipient_id)?.name || del.recipient_id || 'System'}
                          </td>
                          <td className="px-3 py-2">
                            <span className="inline-flex items-center gap-1">
                              {del.channel === 'webhook' ? (
                                <Webhook className="w-3 h-3 text-brand-500" />
                              ) : (
                                <Mail className="w-3 h-3 text-sky-500" />
                              )}
                              <span className="capitalize">{del.channel}</span>
                            </span>
                          </td>
                          <td className="px-3 py-2 text-fg-secondary truncate max-w-[200px]">
                            {del.recipient_destination}
                          </td>
                          <td className="px-3 py-2">
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                del.status === 'SENT'
                                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                                  : del.status === 'DRY_RUN'
                                  ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                                  : del.status === 'EXPIRED'
                                  ? 'bg-slate-500/15 text-slate-600 dark:text-slate-400 border border-slate-500/30'
                                  : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
                              }`}
                            >
                              {del.status}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-fg-secondary">
                            {del.provider_response_code
                              ? `HTTP ${del.provider_response_code}`
                              : del.error_message
                              ? del.error_message
                              : 'Simulated (dry-run)'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="p-4 rounded-lg bg-surface-subtle border border-surface-border text-xs text-fg-secondary text-center">
                  No detailed delivery audit records found.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default AlertDeliveryPanel;
