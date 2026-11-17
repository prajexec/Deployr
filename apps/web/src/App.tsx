import React, { useEffect, useRef, useState } from 'react';
import { LogEntry, SseLogStreamer } from './sse-client';

export interface DeploymentRecord {
  id: string;
  project_id: string;
  status: string;
  commit_sha: string | null;
  output_dir: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export function App() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('deployservice_api_key') || '');
  const [repoUrl, setRepoUrl] = useState('');
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDeployment, setSelectedDeployment] = useState<DeploymentRecord | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isDeploying, setIsDeploying] = useState(false);
  const [isLoadingList, setIsLoadingList] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);

  const terminalRef = useRef<HTMLDivElement>(null);
  const streamerRef = useRef<SseLogStreamer | null>(null);

  // Save API key
  const handleApiKeyChange = (val: string) => {
    setApiKey(val);
    localStorage.setItem('deployservice_api_key', val);
  };

  // Fetch deployments list
  const fetchDeployments = async () => {
    if (!apiKey.trim()) return;
    setIsLoadingList(true);
    try {
      const res = await fetch('http://localhost:3000/deployments', {
        headers: { 'x-api-key': apiKey },
      });
      if (res.ok) {
        const data = await res.json();
        setDeployments(data);
      }
    } catch (err: any) {
      console.warn('Failed fetching deployments:', err.message);
    } finally {
      setIsLoadingList(false);
    }
  };

  // Auto-refresh deployments list
  useEffect(() => {
    fetchDeployments();
    const interval = setInterval(fetchDeployments, 5000);
    return () => clearInterval(interval);
  }, [apiKey]);

  // Auto-scroll log terminal
  useEffect(() => {
    if (autoScroll && terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleScroll = () => {
    if (!terminalRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = terminalRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 40;
    setAutoScroll(isAtBottom);
  };

  // Load single deployment details and logs
  const loadDeployment = async (id: string) => {
    setSelectedId(id);
    setErrorMsg('');
    setSuccessMsg('');
    setLogs([]);

    if (streamerRef.current) {
      streamerRef.current.stop();
      streamerRef.current = null;
    }

    try {
      const res = await fetch(`http://localhost:3000/deployments/${id}`);
      if (!res.ok) {
        throw new Error(`Failed to load deployment: HTTP ${res.status}`);
      }
      const dep: DeploymentRecord = await res.json();
      setSelectedDeployment(dep);

      const isTerminal = ['deployed', 'failed', 'timed_out', 'cancelled'].includes(dep.status);

      if (isTerminal) {
        // Fetch historical raw logs
        try {
          const logRes = await fetch(`http://localhost:3000/deployments/${id}/logs?format=raw`);
          if (logRes.ok) {
            const rawText = await logRes.text();
            const lines = rawText.split('\n').filter(Boolean);
            setLogs(
              lines.map((l) => ({
                id: '',
                ts: Date.now(),
                stream: l.includes('[error]') || l.includes('Error:') ? 'stderr' : 'stdout',
                data: l,
              }))
            );
          }
        } catch {
          // ignore log fetch failure
        }
      } else {
        // Stream live logs via SSE
        const streamer = new SseLogStreamer(`http://localhost:3000/deployments/${id}/logs`);
        streamerRef.current = streamer;
        streamer.start(
          (entry) => {
            setLogs((prev) => [...prev, entry]);
          },
          (endData) => {
            if (endData.status) {
              setSelectedDeployment((prev) => (prev ? { ...prev, status: endData.status } : null));
            }
            fetchDeployments();
          },
          (err) => {
            console.warn('SSE stream error:', err.message);
          }
        );
      }
    } catch (err: any) {
      setErrorMsg(err.message);
    }
  };

  // Trigger new deployment
  const handleDeploy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!repoUrl.trim()) return;
    if (!apiKey.trim()) {
      setErrorMsg('API key is required to trigger deployments. Set your API key in the top bar.');
      return;
    }

    setErrorMsg('');
    setSuccessMsg('');
    setIsDeploying(true);

    try {
      const res = await fetch('http://localhost:3000/deployments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({ repoUrl: repoUrl.trim() }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Deployment request failed with HTTP ${res.status}`);
      }

      setRepoUrl('');
      await fetchDeployments();
      loadDeployment(data.id);
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      setIsDeploying(false);
    }
  };

  // Cancel build
  const handleCancel = async (id: string) => {
    if (!apiKey.trim()) {
      setErrorMsg('API key required to cancel deployments.');
      return;
    }

    setActionLoading(true);
    setErrorMsg('');
    try {
      const res = await fetch(`http://localhost:3000/deployments/${id}/cancel`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to cancel deployment');
      }
      setSuccessMsg(`Deployment ${id} successfully cancelled.`);
      await fetchDeployments();
      if (selectedId === id) {
        await loadDeployment(id);
      }
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  // Delete deployment
  const handleDelete = async (id: string) => {
    if (!apiKey.trim()) {
      setErrorMsg('API key required to delete deployments.');
      return;
    }

    if (
      !window.confirm(
        `Are you sure you want to permanently delete deployment ${id}? This will remove its files, build logs, and preview URL.`
      )
    ) {
      return;
    }

    setActionLoading(true);
    setErrorMsg('');
    try {
      const res = await fetch(`http://localhost:3000/deployments/${id}`, {
        method: 'DELETE',
        headers: { 'x-api-key': apiKey },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to delete deployment');
      }
      setSuccessMsg(`Deployment ${id} successfully deleted.`);
      if (selectedId === id) {
        setSelectedId(null);
      }
      await fetchDeployments();
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  // Rollback project to target deployment
  const handleRollback = async (projectId: string, targetDeploymentId: string) => {
    if (!apiKey.trim()) {
      setErrorMsg('API key required to perform rollbacks.');
      return;
    }

    setActionLoading(true);
    setErrorMsg('');
    try {
      const res = await fetch(`http://localhost:3000/projects/${projectId}/rollback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({ targetDeploymentId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to rollback project release');
      }
      setSuccessMsg(`Project ${projectId} rolled back to deployment ${targetDeploymentId}.`);
      await fetchDeployments();
    } catch (err: any) {
      setErrorMsg(err.message);
    } finally {
      setActionLoading(false);
    }
  };

  const handleCopyLogs = () => {
    const fullText = logs.map((l) => l.data || '').join('\n');
    navigator.clipboard.writeText(fullText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const renderBadge = (status: string) => {
    switch (status) {
      case 'deployed':
        return (
          <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider bg-emerald-950 text-emerald-400 border border-emerald-800">
            Deployed
          </span>
        );
      case 'queued':
        return (
          <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider bg-amber-950 text-amber-400 border border-amber-800 animate-pulse">
            Queued
          </span>
        );
      case 'cloning':
      case 'building':
      case 'uploading':
        return (
          <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider bg-blue-950 text-blue-400 border border-blue-800 animate-pulse">
            {status}
          </span>
        );
      case 'failed':
      case 'timed_out':
        return (
          <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider bg-red-950 text-red-400 border border-red-800">
            {status === 'timed_out' ? 'Timed Out' : 'Failed'}
          </span>
        );
      case 'cancelled':
        return (
          <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider bg-zinc-800 text-zinc-400 border border-zinc-700">
            Cancelled
          </span>
        );
      default:
        return (
          <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider bg-slate-800 text-slate-400">
            {status || 'Unknown'}
          </span>
        );
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur px-6 py-4 flex items-center justify-between sticky top-0 z-20">
        <div className="flex items-center gap-3 cursor-pointer" onClick={() => setSelectedId(null)}>
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-500/20">
            D
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-white flex items-center gap-2">
              DeployService
              <span className="text-[10px] bg-indigo-900/60 text-indigo-300 border border-indigo-700/60 px-2 py-0.5 rounded-full">
                v1.0
              </span>
            </h1>
            <p className="text-xs text-slate-400">
              Production Docker Sandbox & Isolated Edge Hosting
            </p>
          </div>
        </div>

        {/* API Key and Navigation */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-slate-400">API Key:</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => handleApiKeyChange(e.target.value)}
              placeholder="Paste generated API_KEY"
              className="bg-slate-800 border border-slate-700 text-xs px-3 py-1.5 rounded-md text-slate-200 focus:outline-none focus:border-indigo-500 w-56 font-mono"
            />
          </div>
          <button
            onClick={fetchDeployments}
            disabled={isLoadingList}
            className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-1.5 rounded-md border border-slate-700 transition"
          >
            {isLoadingList ? 'Refreshing...' : '↻ Refresh'}
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-6 flex flex-col gap-6">
        {/* Notifications */}
        {errorMsg && (
          <div className="text-xs text-red-300 bg-red-950/40 border border-red-800/80 p-3 rounded-xl flex items-center justify-between shadow-sm">
            <span>{errorMsg}</span>
            <button
              onClick={() => setErrorMsg('')}
              className="text-red-400 hover:text-red-200 ml-4 font-bold"
            >
              ×
            </button>
          </div>
        )}
        {successMsg && (
          <div className="text-xs text-emerald-300 bg-emerald-950/40 border border-emerald-800/80 p-3 rounded-xl flex items-center justify-between shadow-sm">
            <span>{successMsg}</span>
            <button
              onClick={() => setSuccessMsg('')}
              className="text-emerald-400 hover:text-emerald-200 ml-4 font-bold"
            >
              ×
            </button>
          </div>
        )}

        {/* Detail View */}
        {selectedId ? (
          <div className="flex flex-col gap-5">
            {/* Breadcrumb & Navigation */}
            <div className="flex items-center justify-between">
              <button
                onClick={() => {
                  setSelectedId(null);
                  setSelectedDeployment(null);
                  if (streamerRef.current) {
                    streamerRef.current.stop();
                    streamerRef.current = null;
                  }
                }}
                className="text-xs font-medium text-slate-400 hover:text-white transition flex items-center gap-1.5 bg-slate-900 border border-slate-800 px-3 py-1.5 rounded-lg"
              >
                ← Back to All Deployments
              </button>

              <div className="flex items-center gap-3">
                {selectedDeployment &&
                  ['queued', 'cloning', 'building', 'uploading'].includes(
                    selectedDeployment.status
                  ) && (
                    <button
                      onClick={() => handleCancel(selectedDeployment.id)}
                      disabled={actionLoading}
                      className="bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition"
                    >
                      {actionLoading ? 'Cancelling...' : 'Cancel Build'}
                    </button>
                  )}

                {selectedDeployment && selectedDeployment.status === 'deployed' && (
                  <button
                    onClick={() =>
                      handleRollback(selectedDeployment.project_id, selectedDeployment.id)
                    }
                    disabled={actionLoading}
                    className="bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5 rounded-lg transition"
                  >
                    {actionLoading ? 'Rolling back...' : 'Rollback Release To Here'}
                  </button>
                )}

                {selectedDeployment &&
                  ['deployed', 'failed', 'cancelled', 'timed_out'].includes(
                    selectedDeployment.status
                  ) && (
                    <button
                      onClick={() => handleDelete(selectedDeployment.id)}
                      disabled={actionLoading}
                      className="bg-red-950 hover:bg-red-900 border border-red-800 disabled:opacity-50 text-red-300 text-xs font-semibold px-3 py-1.5 rounded-lg transition"
                    >
                      {actionLoading ? 'Deleting...' : 'Delete Deployment'}
                    </button>
                  )}
              </div>
            </div>

            {/* Deployment Metadata Card */}
            {selectedDeployment && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-sm font-semibold text-white">
                        {selectedDeployment.id}
                      </span>
                      {renderBadge(selectedDeployment.status)}
                    </div>
                    <span className="text-xs text-slate-400 font-mono">
                      Project ID:{' '}
                      <a
                        href={`http://${selectedDeployment.project_id}.localhost:8080`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-indigo-400 hover:underline"
                      >
                        {selectedDeployment.project_id} ↗
                      </a>
                    </span>
                  </div>

                  {selectedDeployment.status === 'deployed' && (
                    <div className="flex items-center gap-3">
                      <a
                        href={`http://${selectedDeployment.id}.localhost:8080`}
                        target="_blank"
                        rel="noreferrer"
                        className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-3.5 py-2 rounded-lg transition shadow-lg shadow-emerald-600/20"
                      >
                        Preview URL ↗
                      </a>
                      <a
                        href={`http://${selectedDeployment.project_id}.localhost:8080`}
                        target="_blank"
                        rel="noreferrer"
                        className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold px-3.5 py-2 rounded-lg transition shadow-lg shadow-indigo-600/20"
                      >
                        Production Release ↗
                      </a>
                    </div>
                  )}
                </div>

                {/* Additional Details */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs border-t border-slate-800 pt-3">
                  <div>
                    <span className="text-slate-500 block">Commit SHA</span>
                    <span className="font-mono text-slate-300">
                      {selectedDeployment.commit_sha
                        ? selectedDeployment.commit_sha.slice(0, 10)
                        : '—'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block">Output Directory</span>
                    <span className="font-mono text-slate-300">
                      {selectedDeployment.output_dir || '—'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block">Created At</span>
                    <span className="text-slate-300">
                      {new Date(selectedDeployment.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 block">Duration</span>
                    <span className="text-slate-300">
                      {selectedDeployment.started_at && selectedDeployment.finished_at
                        ? `${(
                            (new Date(selectedDeployment.finished_at).getTime() -
                              new Date(selectedDeployment.started_at).getTime()) /
                            1000
                          ).toFixed(1)}s`
                        : '—'}
                    </span>
                  </div>
                </div>

                {/* Error Banner */}
                {selectedDeployment.error_message && (
                  <div className="bg-red-950/30 border border-red-900/60 p-3 rounded-lg text-xs text-red-300 font-mono">
                    <span className="font-semibold block mb-0.5 text-red-400">Error Details:</span>
                    {selectedDeployment.error_message}
                  </div>
                )}
              </div>
            )}

            {/* Terminal Live / Archived Logs */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl overflow-hidden flex flex-col shadow-2xl min-h-[460px]">
              <div className="bg-slate-900 border-b border-slate-800 px-4 py-2.5 flex items-center justify-between text-xs text-slate-400">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500/80"></div>
                  <div className="w-2.5 h-2.5 rounded-full bg-amber-500/80"></div>
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/80"></div>
                  <span className="ml-2 font-mono text-slate-300">Build Console</span>
                </div>
                <div className="flex items-center gap-3">
                  {!autoScroll && (
                    <button
                      onClick={() => setAutoScroll(true)}
                      className="text-amber-400 bg-amber-950/40 border border-amber-800/60 px-2 py-0.5 rounded text-[10px]"
                    >
                      Scroll Paused (Resume)
                    </button>
                  )}
                  <button
                    onClick={handleCopyLogs}
                    className="hover:text-slate-200 transition bg-slate-800 px-2 py-1 rounded"
                  >
                    {copied ? 'Copied!' : 'Copy Logs'}
                  </button>
                </div>
              </div>

              <div
                ref={terminalRef}
                onScroll={handleScroll}
                className="flex-1 p-4 font-mono text-xs overflow-y-auto leading-relaxed select-text space-y-0.5 max-h-[500px]"
              >
                {logs.length === 0 ? (
                  <div className="text-slate-600 italic">No output received yet...</div>
                ) : (
                  logs.map((log, idx) => (
                    <div
                      key={idx}
                      className={
                        log.stream === 'stderr'
                          ? 'text-red-400'
                          : log.stream === 'system'
                            ? 'text-amber-400 font-semibold'
                            : 'text-slate-300'
                      }
                    >
                      {log.data}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        ) : (
          /* List View (Dashboard) */
          <div className="flex flex-col gap-6">
            {/* Deploy New Repository Form */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm">
              <h2 className="text-sm font-semibold text-slate-200 mb-3">Deploy New Repository</h2>
              <form onSubmit={handleDeploy} className="flex gap-3">
                <input
                  type="url"
                  required
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/owner/repository"
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500 font-mono"
                />
                <button
                  type="submit"
                  disabled={isDeploying || !repoUrl.trim()}
                  className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium px-5 py-2.5 rounded-lg text-sm transition shadow-sm"
                >
                  {isDeploying ? 'Deploying...' : 'Deploy'}
                </button>
              </form>
            </div>

            {/* Deployments Table */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
              <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-200">Recent Deployments</h3>
                <span className="text-xs text-slate-400 font-mono">
                  {deployments.length} deployments
                </span>
              </div>

              {deployments.length === 0 ? (
                <div className="p-8 text-center text-slate-500 text-sm">
                  {apiKey.trim()
                    ? 'No deployments found. Submit a repository URL above to start.'
                    : 'Enter your API key in the top bar to load deployments.'}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-950/60 text-slate-400 uppercase font-mono text-[10px] tracking-wider border-b border-slate-800">
                      <tr>
                        <th className="px-5 py-3">Deployment ID</th>
                        <th className="px-5 py-3">Project</th>
                        <th className="px-5 py-3">Status</th>
                        <th className="px-5 py-3">Commit</th>
                        <th className="px-5 py-3">Created</th>
                        <th className="px-5 py-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 font-mono">
                      {deployments.map((d) => (
                        <tr
                          key={d.id}
                          className="hover:bg-slate-800/40 transition cursor-pointer"
                          onClick={() => loadDeployment(d.id)}
                        >
                          <td className="px-5 py-3.5 font-semibold text-indigo-400 hover:underline">
                            {d.id.slice(0, 10)}...{d.id.slice(-6)}
                          </td>
                          <td className="px-5 py-3.5 text-slate-300">
                            <a
                              href={`http://${d.project_id}.localhost:8080`}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="text-slate-400 hover:text-white transition hover:underline"
                            >
                              {d.project_id} ↗
                            </a>
                          </td>
                          <td className="px-5 py-3.5">{renderBadge(d.status)}</td>
                          <td className="px-5 py-3.5 text-slate-400">
                            {d.commit_sha ? d.commit_sha.slice(0, 7) : '—'}
                          </td>
                          <td className="px-5 py-3.5 text-slate-400">
                            {new Date(d.created_at).toLocaleTimeString()}
                          </td>
                          <td
                            className="px-5 py-3.5 text-right font-sans"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="flex items-center justify-end gap-2">
                              {['queued', 'cloning', 'building', 'uploading'].includes(
                                d.status
                              ) && (
                                <button
                                  onClick={() => handleCancel(d.id)}
                                  className="text-[11px] bg-red-950 hover:bg-red-900 text-red-400 border border-red-800 px-2 py-1 rounded transition"
                                >
                                  Cancel
                                </button>
                              )}
                              {d.status === 'deployed' && (
                                <>
                                  <a
                                    href={`http://${d.id}.localhost:8080`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-[11px] bg-emerald-950 hover:bg-emerald-900 text-emerald-400 border border-emerald-800 px-2 py-1 rounded transition"
                                  >
                                    Preview ↗
                                  </a>
                                  <button
                                    onClick={() => handleRollback(d.project_id, d.id)}
                                    className="text-[11px] bg-purple-950 hover:bg-purple-900 text-purple-400 border border-purple-800 px-2 py-1 rounded transition"
                                  >
                                    Rollback
                                  </button>
                                </>
                              )}
                              <button
                                onClick={() => loadDeployment(d.id)}
                                className="text-[11px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded border border-slate-700 transition"
                              >
                                Logs
                              </button>
                              {['deployed', 'failed', 'cancelled', 'timed_out'].includes(
                                d.status
                              ) && (
                                <button
                                  onClick={() => handleDelete(d.id)}
                                  className="text-[11px] bg-red-950/60 hover:bg-red-900 text-red-400 border border-red-900/50 hover:border-red-700 px-2 py-1 rounded transition"
                                >
                                  Delete
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
