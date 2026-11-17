import React, { useEffect, useRef, useState } from 'react';
import { LogEntry, SseLogStreamer } from './sse-client';

export function App() {
  const [apiKey, setApiKey] = useState(
    () => localStorage.getItem('deployservice_api_key') || 'dev-api-key'
  );
  const [repoUrl, setRepoUrl] = useState('');
  const [deploymentId, setDeploymentId] = useState('');
  const [status, setStatus] = useState<string>('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isDeploying, setIsDeploying] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);

  const terminalRef = useRef<HTMLDivElement>(null);
  const streamerRef = useRef<SseLogStreamer | null>(null);

  // Save API key to localStorage
  const handleApiKeyChange = (val: string) => {
    setApiKey(val);
    localStorage.setItem('deployservice_api_key', val);
  };

  // Auto-scroll handler
  useEffect(() => {
    if (autoScroll && terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // Detect manual scroll up to pause auto-scroll
  const handleScroll = () => {
    if (!terminalRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = terminalRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 40;
    setAutoScroll(isAtBottom);
  };

  const startStream = (id: string) => {
    if (streamerRef.current) {
      streamerRef.current.stop();
    }

    const streamer = new SseLogStreamer(`http://localhost:3000/deployments/${id}/logs`);
    streamerRef.current = streamer;

    streamer.start(
      (entry) => {
        setLogs((prev) => [...prev, entry]);
      },
      (endData) => {
        if (endData.status) {
          setStatus(endData.status);
        }
      },
      (err) => {
        console.warn('SSE connection error:', err.message);
      }
    );
  };

  const handleDeploy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!repoUrl.trim()) return;

    setErrorMsg('');
    setIsDeploying(true);
    setLogs([]);
    setStatus('queued');

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

      setDeploymentId(data.id);
      setStatus(data.status || 'queued');
      startStream(data.id);
    } catch (err: any) {
      setErrorMsg(err.message);
      setStatus('error');
    } finally {
      setIsDeploying(false);
    }
  };

  const handleCopyLogs = () => {
    const fullText = logs.map((l) => l.data || '').join('');
    navigator.clipboard.writeText(fullText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const liveSiteUrl = deploymentId ? `http://${deploymentId}.localhost:8080` : '';

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Top Header */}
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-500/20">
            D
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-white">DeployService</h1>
            <p className="text-xs text-slate-400">Self-Hosted Static Site Platform</p>
          </div>
        </div>

        {/* API Key Input */}
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-slate-400">API Key:</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => handleApiKeyChange(e.target.value)}
            placeholder="Enter API key"
            className="bg-slate-800 border border-slate-700 text-xs px-3 py-1.5 rounded-md text-slate-200 focus:outline-none focus:border-indigo-500 w-44"
          />
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-6 flex flex-col gap-6">
        {/* Deploy Form */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-200 mb-3">Deploy New Repository</h2>
          <form onSubmit={handleDeploy} className="flex gap-3">
            <input
              type="url"
              required
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/owner/repository"
              className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-4 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            />
            <button
              type="submit"
              disabled={isDeploying || !repoUrl.trim()}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium px-5 py-2.5 rounded-lg text-sm transition shadow-sm"
            >
              {isDeploying ? 'Deploying...' : 'Deploy'}
            </button>
          </form>

          {errorMsg && (
            <div className="mt-3 text-xs text-red-400 bg-red-950/30 border border-red-900/50 p-2.5 rounded-lg">
              {errorMsg}
            </div>
          )}
        </div>

        {/* Active Deployment Card */}
        {deploymentId && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex items-center justify-between">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-slate-400 font-mono">ID: {deploymentId}</span>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-200">Status:</span>
                <span
                  className={`text-xs px-2.5 py-0.5 rounded-full font-semibold uppercase tracking-wider ${
                    status === 'deployed'
                      ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                      : status === 'failed' || status === 'timed_out'
                        ? 'bg-red-950 text-red-400 border border-red-800'
                        : 'bg-amber-950 text-amber-400 border border-amber-800 animate-pulse'
                  }`}
                >
                  {status || 'pending'}
                </span>
              </div>
            </div>

            {status === 'deployed' && (
              <a
                href={liveSiteUrl}
                target="_blank"
                rel="noreferrer"
                className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-4 py-2 rounded-lg transition shadow-lg shadow-emerald-600/20"
              >
                Open Live Site ↗
              </a>
            )}
          </div>
        )}

        {/* Terminal Log Viewer */}
        <div className="flex-1 bg-slate-950 border border-slate-800 rounded-xl overflow-hidden flex flex-col shadow-2xl min-h-[420px]">
          {/* Terminal Header */}
          <div className="bg-slate-900 border-b border-slate-800 px-4 py-2.5 flex items-center justify-between text-xs text-slate-400">
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500/80"></div>
              <div className="w-2.5 h-2.5 rounded-full bg-amber-500/80"></div>
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/80"></div>
              <span className="ml-2 font-mono text-slate-300">Live Build Output</span>
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

          {/* Terminal Output Body */}
          <div
            ref={terminalRef}
            onScroll={handleScroll}
            className="flex-1 p-4 font-mono text-xs overflow-y-auto leading-relaxed select-text space-y-0.5"
          >
            {logs.length === 0 ? (
              <div className="text-slate-600 italic">
                No logs yet. Trigger a deployment to view real-time output.
              </div>
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
      </main>
    </div>
  );
}
