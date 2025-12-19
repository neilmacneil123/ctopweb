import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'
import { fetchContainerDetail, fetchContainers } from './api'
import type { ContainerDetail, ContainerInfo } from './types'

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

const HISTORY_POINTS = 40

type MetricHistory = {
  cpu: number[]
  mem: number[]
  netRx: number[]
  netTx: number[]
  blockRead: number[]
  blockWrite: number[]
}

const Sparkline = ({
  data,
  max,
  colorClass,
}: {
  data: number[]
  max?: number
  colorClass: string
}) => {
  const safeData = data.length ? data : [0]
  const peak = max ?? Math.max(...safeData, 1)
  const width = 120
  const height = 40
  const step = safeData.length > 1 ? width / (safeData.length - 1) : 0
  const points = safeData
    .map((value, index) => {
      const safeValue = Number.isFinite(value) ? value : 0
      const ratio = peak > 0 ? Math.min(Math.max(safeValue / peak, 0), 1) : 0
      const x = index * step
      const y = height - ratio * (height - 4) - 2
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
  const lastPoint = points.split(' ').slice(-1)[0] || '0,0'
  const [lastX, lastY] = lastPoint.split(',')

  return (
    <div className={`sparkline ${colorClass}`}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <polyline points={points} />
        <circle cx={lastX} cy={lastY} r="2.5" />
      </svg>
    </div>
  )
}

function formatTimestamp(value: string | null) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleTimeString()
}

function formatDateTime(value: string | null) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString()
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
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detailById, setDetailById] = useState<Record<string, ContainerDetail>>({})
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [history, setHistory] = useState<Record<string, MetricHistory>>({})

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

  useEffect(() => {
    setHistory((prev) => {
      const next: Record<string, MetricHistory> = {}
      const append = (list: number[], value: number) => {
        const nextList = list.concat(Number.isFinite(value) ? value : 0)
        return nextList.slice(-HISTORY_POINTS)
      }

      containers.forEach((container) => {
        const current = prev[container.id] || {
          cpu: [],
          mem: [],
          netRx: [],
          netTx: [],
          blockRead: [],
          blockWrite: [],
        }
        next[container.id] = {
          cpu: append(current.cpu, container.cpu),
          mem: append(current.mem, container.memory.percent),
          netRx: append(current.netRx, container.netIOBytes?.rx ?? 0),
          netTx: append(current.netTx, container.netIOBytes?.tx ?? 0),
          blockRead: append(current.blockRead, container.blockIOBytes?.read ?? 0),
          blockWrite: append(current.blockWrite, container.blockIOBytes?.write ?? 0),
        }
      })

      return next
    })
  }, [containers])

  useEffect(() => {
    if (selectedId && !containers.some((container) => container.id === selectedId)) {
      setSelectedId(null)
    }
  }, [containers, selectedId])

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
  const selectedContainer = useMemo(
    () => (selectedId ? containers.find((container) => container.id === selectedId) || null : null),
    [containers, selectedId]
  )
  const selectedDetail = selectedId ? detailById[selectedId] || null : null
  const selectedHistory = selectedId ? history[selectedId] || null : null

  const loadDetail = useCallback(async (containerId: string) => {
    setDetailLoading(true)
    setDetailError(null)
    try {
      const detail = await fetchContainerDetail(containerId)
      setDetailById((prev) => ({ ...prev, [containerId]: detail }))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load container detail'
      setDetailError(message)
    } finally {
      setDetailLoading(false)
    }
  }, [])

  const handleSelect = (containerId: string) => {
    if (selectedId === containerId) {
      setSelectedId(null)
      setDetailError(null)
      return
    }
    setSelectedId(containerId)
    setDetailError(null)
    if (!detailById[containerId]) {
      loadDetail(containerId)
    }
  }

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
                          <button className="name-button" onClick={() => handleSelect(container.id)}>
                            {container.name}
                          </button>
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
        {selectedId && (
          <div className="detail-panel">
            <div className="detail-header">
              <div>
                <div className="detail-title">
                  <span className={`state-indicator ${stateClassMap[selectedContainer?.state ?? 'unknown'] ?? 'state-unknown'}`} />
                  <h2>{selectedDetail?.name || selectedContainer?.name || 'Container'}</h2>
                </div>
                <p className="detail-subtle">
                  {selectedDetail?.image || '-'} · {selectedContainer?.raw.shortId || selectedDetail?.id || '-'}
                </p>
              </div>
              <div className="detail-actions">
                <button className="control" onClick={() => selectedId && loadDetail(selectedId)} disabled={detailLoading}>
                  Refresh Detail
                </button>
                <button className="control" onClick={() => setSelectedId(null)}>
                  Close
                </button>
              </div>
            </div>

            {detailError && <div className="error-banner">{detailError}</div>}

            <div className="detail-grid">
              <section className="detail-card">
                <h3>Overview</h3>
                <dl>
                  <div>
                    <dt>Status</dt>
                    <dd>{selectedDetail?.status || selectedContainer?.state || '-'}</dd>
                  </div>
                  <div>
                    <dt>Health</dt>
                    <dd>{selectedDetail?.health || '-'}</dd>
                  </div>
                  <div>
                    <dt>Uptime</dt>
                    <dd>{selectedContainer?.uptime || '-'}</dd>
                  </div>
                  <div>
                    <dt>PID</dt>
                    <dd>{selectedDetail?.pid ?? selectedContainer?.pids ?? '-'}</dd>
                  </div>
                  <div>
                    <dt>Restarts</dt>
                    <dd>{selectedDetail?.restartCount ?? '-'}</dd>
                  </div>
                  <div>
                    <dt>Ports</dt>
                    <dd>{selectedDetail?.ports || selectedContainer?.ports || '-'}</dd>
                  </div>
                  <div>
                    <dt>Networks</dt>
                    <dd>{selectedDetail?.networks || selectedContainer?.networks || '-'}</dd>
                  </div>
                  <div>
                    <dt>IPs</dt>
                    <dd>{selectedDetail?.ipAddresses?.length ? selectedDetail.ipAddresses.join(', ') : '-'}</dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd>{formatDateTime(selectedDetail?.created || null)}</dd>
                  </div>
                  <div>
                    <dt>Started</dt>
                    <dd>{formatDateTime(selectedDetail?.startedAt || null)}</dd>
                  </div>
                </dl>
              </section>

              <section className="detail-card">
                <h3>Runtime</h3>
                <dl>
                  <div>
                    <dt>Command</dt>
                    <dd>{selectedDetail?.command || '-'}</dd>
                  </div>
                  <div>
                    <dt>Entrypoint</dt>
                    <dd>{selectedDetail?.entrypoint || '-'}</dd>
                  </div>
                  <div>
                    <dt>User</dt>
                    <dd>{selectedDetail?.user || '-'}</dd>
                  </div>
                  <div>
                    <dt>Working Dir</dt>
                    <dd>{selectedDetail?.workingDir || '-'}</dd>
                  </div>
                </dl>
              </section>

              <section className="detail-card detail-metrics">
                <h3>Resource Trends</h3>
                <div className="chart-grid">
                  <div className="chart-block">
                    <div className="chart-header">
                      <span>CPU</span>
                      <span>{selectedContainer ? `${selectedContainer.cpu.toFixed(1)}%` : '-'}</span>
                    </div>
                    <Sparkline data={selectedHistory?.cpu || []} max={100} colorClass="cpu" />
                  </div>
                  <div className="chart-block">
                    <div className="chart-header">
                      <span>MEM</span>
                      <span>
                        {selectedContainer
                          ? `${selectedContainer.memory.usage} / ${selectedContainer.memory.limit}`
                          : '-'}
                      </span>
                    </div>
                    <Sparkline data={selectedHistory?.mem || []} max={100} colorClass="mem" />
                  </div>
                  <div className="chart-block">
                    <div className="chart-header">
                      <span>NET RX</span>
                      <span>{selectedContainer?.netIO.rx || '-'}</span>
                    </div>
                    <Sparkline data={selectedHistory?.netRx || []} colorClass="net" />
                  </div>
                  <div className="chart-block">
                    <div className="chart-header">
                      <span>NET TX</span>
                      <span>{selectedContainer?.netIO.tx || '-'}</span>
                    </div>
                    <Sparkline data={selectedHistory?.netTx || []} colorClass="net-alt" />
                  </div>
                  <div className="chart-block">
                    <div className="chart-header">
                      <span>IO READ</span>
                      <span>{selectedContainer?.blockIO.read || '-'}</span>
                    </div>
                    <Sparkline data={selectedHistory?.blockRead || []} colorClass="io" />
                  </div>
                  <div className="chart-block">
                    <div className="chart-header">
                      <span>IO WRITE</span>
                      <span>{selectedContainer?.blockIO.write || '-'}</span>
                    </div>
                    <Sparkline data={selectedHistory?.blockWrite || []} colorClass="io-alt" />
                  </div>
                </div>
              </section>

              <section className="detail-card detail-env">
                <h3>Environment</h3>
                {detailLoading && !selectedDetail ? (
                  <p className="detail-muted">Loading environment variables…</p>
                ) : selectedDetail?.env?.length ? (
                  <div className="env-grid">
                    {selectedDetail.env.map((item) => (
                      <div key={item.key} className="env-row">
                        <span>{item.key}</span>
                        <span>{item.value || '-'}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="detail-muted">No environment variables reported.</p>
                )}
              </section>
            </div>
          </div>
        )}
        <div className="footer-note">
          Auto refresh {isPaused ? 'paused' : `every ${Math.round(refreshMs / 1000)}s`}
          {refreshing && !loading ? ' · updating…' : ''}
        </div>
      </div>
    </div>
  )
}

export default App
