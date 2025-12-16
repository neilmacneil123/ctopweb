import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'
import { fetchContainers } from './api'
import type { ContainerInfo } from './types'

const REFRESH_OPTIONS = [
  { label: '3s', value: 3000 },
  { label: '5s', value: 5000 },
  { label: '10s', value: 10000 },
  { label: '30s', value: 30000 },
]

const stateClassMap: Record<string, string> = {
  running: 'state-running',
  paused: 'state-paused',
  restarting: 'state-restarting',
  stopped: 'state-stopped',
  unknown: 'state-unknown',
}

const UsageBar = ({ percent, label, type }: { percent: number; label: string; type: 'cpu' | 'mem' }) => {
  const safePercent = Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 100) : 0

  return (
    <div className="usage">
      <div className={`usage-bar ${type}`}>
        <span style={{ width: `${safePercent}%` }} />
      </div>
      <span className="usage-label">{label}</span>
    </div>
  )
}

function formatTimestamp(value: string | null) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleTimeString()
}

function splitList(value: string) {
  if (!value || value === '-') return ['-']
  return value.split(',').map((item) => item.trim())
}

function App() {
  const [containers, setContainers] = useState<ContainerInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filterQuery, setFilterQuery] = useState('')
  const [refreshMs, setRefreshMs] = useState(5000)
  const [isPaused, setIsPaused] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<string | null>(null)

  const loadContainers = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent ?? false
    if (silent) {
      setRefreshing(true)
    } else {
      setLoading(true)
    }

    try {
      const data = await fetchContainers()
      setContainers(data.containers)
      setLastUpdated(data.fetchedAt)
      setError(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load containers'
      setError(message)
    } finally {
      if (silent) {
        setRefreshing(false)
      } else {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    loadContainers()
  }, [loadContainers])

  useEffect(() => {
    if (isPaused) return undefined
    const id = setInterval(() => {
      loadContainers({ silent: true })
    }, refreshMs)
    return () => clearInterval(id)
  }, [isPaused, refreshMs, loadContainers])

  const filteredContainers = useMemo(() => {
    const needle = filterQuery.trim().toLowerCase()
    if (!needle) return containers
    return containers.filter((container) => {
      return (
        container.name.toLowerCase().includes(needle) ||
        container.raw.shortId.toLowerCase().includes(needle) ||
        container.networks.toLowerCase().includes(needle)
      )
    })
  }, [containers, filterQuery])

  const runningCount = useMemo(() => containers.filter((c) => c.state === 'running').length, [containers])

  const handleManualRefresh = () => loadContainers()

  return (
    <div className="app-shell">
      <div className="panel">
        <div className="header">
          <h1 className="header-title">
            ctop<span>·web</span>
          </h1>
          <div className="meta">
            <span>
              Containers: <strong>{containers.length}</strong>
            </span>
            <span>
              Running: <strong>{runningCount}</strong>
            </span>
            <span>
              Updated: <strong>{formatTimestamp(lastUpdated)}</strong>
            </span>
          </div>
        </div>

        <div className="controls">
          <input
            type="search"
            placeholder="Filter containers (name, id, network)"
            value={filterQuery}
            onChange={(event) => setFilterQuery(event.target.value)}
          />
          <div className="control-group">
            <button className="control primary" onClick={handleManualRefresh} disabled={loading}>
              Refresh
            </button>
            <button className="control" onClick={() => setIsPaused((value) => !value)}>
              {isPaused ? 'Resume Auto' : 'Pause Auto'}
            </button>
            <select className="control" value={refreshMs} onChange={(event) => setRefreshMs(Number(event.target.value))}>
              {REFRESH_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  Every {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <div className="table-container">
          {loading ? (
            <div className="loading-state">
              <div className="loading-spinner" />
              <p>Gathering container stats…</p>
            </div>
          ) : filteredContainers.length === 0 ? (
            <div className="empty-state">
              <p>No containers match your filters.</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>NAME</th>
                  <th>PORTS</th>
                  <th>NETWORKS</th>
                  <th>CPU</th>
                  <th>MEM</th>
                  <th>NET RX/TX</th>
                  <th>IO R/W</th>
                  <th>PIDS</th>
                  <th>UPTIME</th>
                </tr>
              </thead>
              <tbody>
                {filteredContainers.map((container) => (
                  <tr key={container.id}>
                    <td>
                      <div className="name-cell">
                        <span className={`state-indicator ${stateClassMap[container.state] ?? 'state-unknown'}`} />
                        <div className="name-stack">
                          <span className="name">{container.name}</span>
                          <span className="subtle">{container.raw.shortId}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="badge-stack">
                        {splitList(container.ports).map((item, index) => (
                          <span key={index} className="net-badge">
                            {item}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      <div className="badge-stack">
                        {splitList(container.networks).map((network, index) => (
                          <span key={index} className="net-badge">
                            {network}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      <UsageBar type="cpu" percent={container.cpu} label={`${container.cpu.toFixed(1)}%`} />
                    </td>
                    <td>
                      <UsageBar
                        type="mem"
                        percent={container.memory.percent}
                        label={`${container.memory.usage} / ${container.memory.limit}`}
                      />
                    </td>
                    <td>
                      <div className="badge-stack">
                        <span className="net-badge">⬇ {container.netIO.rx}</span>
                        <span className="net-badge">⬆ {container.netIO.tx}</span>
                      </div>
                    </td>
                    <td>
                      <div className="badge-stack">
                        <span className="block-badge">R {container.blockIO.read}</span>
                        <span className="block-badge">W {container.blockIO.write}</span>
                      </div>
                    </td>
                    <td>{container.pids}</td>
                    <td>{container.uptime}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="footer-note">
          Auto refresh {isPaused ? 'paused' : `every ${Math.round(refreshMs / 1000)}s`}
          {refreshing && !loading ? ' · updating…' : ''}
        </div>
      </div>
    </div>
  )
}

export default App
