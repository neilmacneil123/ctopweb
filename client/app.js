(() => {
  const REFRESH_OPTIONS = [
    { label: '3s', value: 3000 },
    { label: '5s', value: 5000 },
    { label: '10s', value: 10000 },
    { label: '30s', value: 30000 },
  ];

  const stateClassMap = {
    running: 'state-running',
    paused: 'state-paused',
    restarting: 'state-restarting',
    stopped: 'state-stopped',
    unknown: 'state-unknown',
  };

  const API_BASE_URL = (() => {
    const meta = document.querySelector('meta[name="ctop-api-base"]');
    if (meta && meta.content) return meta.content;
    if (window.CTOP_API_BASE_URL) return window.CTOP_API_BASE_URL;
    return '';
  })();

  const state = {
    containers: [],
    loading: true,
    refreshing: false,
    error: null,
    filterQuery: '',
    refreshMs: 5000,
    isPaused: false,
    lastUpdated: null,
    selectedId: null,
    detailById: {},
    detailLoading: false,
    detailError: null,
    history: {},
  };

  const HISTORY_POINTS = 40;
  let refreshTimer = null;

  const els = {
    containersCount: document.querySelector('[data-containers-count]'),
    runningCount: document.querySelector('[data-running-count]'),
    updatedTime: document.querySelector('[data-updated-time]'),
    filterInput: document.getElementById('filter-input'),
    refreshButton: document.getElementById('refresh-button'),
    pauseButton: document.getElementById('pause-button'),
    refreshSelect: document.getElementById('refresh-select'),
    errorBanner: document.getElementById('error-banner'),
    tableContainer: document.getElementById('table-container'),
    footerNote: document.getElementById('footer-note'),
  };

  function escapeHTML(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatTimestamp(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleTimeString();
  }

  function formatDateTime(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleString();
  }

  function splitList(value) {
    if (!value || value === '-') return ['-'];
    return value.split(',').map((item) => item.trim());
  }

  function valueOrDash(value) {
    if (value === null || value === undefined || value === '') return '-';
    return value;
  }

  function updateHistory(containers) {
    const next = { ...state.history };
    const append = (list, value) => {
      const safeValue = Number.isFinite(value) ? value : 0;
      return list.concat(safeValue).slice(-HISTORY_POINTS);
    };

    containers.forEach((container) => {
      const current = next[container.id] || {
        cpu: [],
        mem: [],
        netRx: [],
        netTx: [],
        blockRead: [],
        blockWrite: [],
      };
      next[container.id] = {
        cpu: append(current.cpu, container.cpu),
        mem: append(current.mem, container.memory.percent),
        netRx: append(current.netRx, container.netIOBytes ? container.netIOBytes.rx : 0),
        netTx: append(current.netTx, container.netIOBytes ? container.netIOBytes.tx : 0),
        blockRead: append(current.blockRead, container.blockIOBytes ? container.blockIOBytes.read : 0),
        blockWrite: append(current.blockWrite, container.blockIOBytes ? container.blockIOBytes.write : 0),
      };
    });

    state.history = next;
  }

  async function fetchContainers() {
    const response = await fetch(`${API_BASE_URL}/api/containers`);
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || 'Failed to load container stats');
    }
    return response.json();
  }

  async function fetchContainerDetail(id) {
    const response = await fetch(`${API_BASE_URL}/api/containers/${id}`);
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || 'Failed to load container detail');
    }
    return response.json();
  }

  async function loadContainers({ silent } = {}) {
    if (silent) {
      state.refreshing = true;
    } else {
      state.loading = true;
    }
    render();

    try {
      const data = await fetchContainers();
      state.containers = data.containers;
      state.lastUpdated = data.fetchedAt;
      state.error = null;
      updateHistory(state.containers);
      if (state.selectedId && !state.containers.some((c) => c.id === state.selectedId)) {
        state.selectedId = null;
      }
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'Unable to load containers';
    } finally {
      state.loading = false;
      state.refreshing = false;
      render();
    }
  }

  async function loadDetail(containerId) {
    state.detailLoading = true;
    state.detailError = null;
    render();
    try {
      const detail = await fetchContainerDetail(containerId);
      state.detailById[containerId] = detail;
    } catch (err) {
      state.detailError = err instanceof Error ? err.message : 'Unable to load container detail';
    } finally {
      state.detailLoading = false;
      render();
    }
  }

  function startAutoRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
    }
    if (!state.isPaused) {
      refreshTimer = setInterval(() => loadContainers({ silent: true }), state.refreshMs);
    }
  }

  function renderSparkline(data, max, colorClass) {
    const safeData = data && data.length ? data : [0];
    const peak = max || Math.max(...safeData, 1);
    const width = 120;
    const height = 40;
    const step = safeData.length > 1 ? width / (safeData.length - 1) : 0;
    const points = safeData
      .map((value, index) => {
        const safeValue = Number.isFinite(value) ? value : 0;
        const ratio = peak > 0 ? Math.min(Math.max(safeValue / peak, 0), 1) : 0;
        const x = index * step;
        const y = height - ratio * (height - 4) - 2;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
    const lastPoint = points.split(' ').slice(-1)[0] || '0,0';
    const parts = lastPoint.split(',');
    const lastX = parts[0] || '0';
    const lastY = parts[1] || '0';

    return `
      <div class="sparkline ${colorClass}">
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
          <polyline points="${points}"></polyline>
          <circle cx="${lastX}" cy="${lastY}" r="2.5"></circle>
        </svg>
      </div>
    `;
  }

  function renderUsageBar(type, percent, label) {
    const safePercent = Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 100) : 0;
    return `
      <div class="usage">
        <div class="usage-bar ${type}">
          <span style="width: ${safePercent}%"></span>
        </div>
        <span class="usage-label">${escapeHTML(label)}</span>
      </div>
    `;
  }

  function renderDetailRow(container) {
    const detail = state.detailById[container.id] || null;
    const history = state.history[container.id] || null;
    const detailError = state.detailError;
    const detailLoading = state.detailLoading;

    const envSection = detailLoading && !detail
      ? '<p class="detail-muted">Loading environment variables.</p>'
      : detail && detail.env && detail.env.length
        ? `<div class="env-grid">
            ${detail.env
              .map(
                (item) => `
                  <div class="env-row">
                    <span>${escapeHTML(item.key)}</span>
                    <span>${escapeHTML(item.value || '-')}</span>
                  </div>
                `
              )
              .join('')}
          </div>`
        : '<p class="detail-muted">No environment variables reported.</p>';

    return `
      <tr class="detail-row">
        <td colspan="9">
          <div class="detail-panel inline">
            <div class="detail-header">
              <div>
                <div class="detail-title">
                  <span class="state-indicator ${stateClassMap[container.state] || 'state-unknown'}"></span>
                  <h2>${escapeHTML((detail && detail.name) || container.name)}</h2>
                </div>
                <p class="detail-subtle">
                  ${escapeHTML((detail && detail.image) || '-')} ú ${escapeHTML(container.raw.shortId)}
                </p>
              </div>
              <div class="detail-actions">
                <button
                  class="control"
                  type="button"
                  data-action="refresh-detail"
                  data-id="${escapeHTML(container.id)}"
                  ${detailLoading ? 'disabled' : ''}
                >
                  Refresh Detail
                </button>
                <button class="control" type="button" data-action="close-detail">Close</button>
              </div>
            </div>

            ${detailError ? `<div class="error-banner">${escapeHTML(detailError)}</div>` : ''}

            <div class="detail-grid">
              <section class="detail-card">
                <h3>Overview</h3>
                <dl>
                  <div><dt>Status</dt><dd>${escapeHTML(valueOrDash((detail && detail.status) || container.state))}</dd></div>
                  <div><dt>Health</dt><dd>${escapeHTML(valueOrDash(detail && detail.health))}</dd></div>
                  <div><dt>Uptime</dt><dd>${escapeHTML(valueOrDash(container.uptime))}</dd></div>
                  <div><dt>PID</dt><dd>${escapeHTML(valueOrDash(detail ? detail.pid : container.pids))}</dd></div>
                  <div><dt>Restarts</dt><dd>${escapeHTML(valueOrDash(detail ? detail.restartCount : null))}</dd></div>
                  <div><dt>Ports</dt><dd>${escapeHTML(valueOrDash((detail && detail.ports) || container.ports))}</dd></div>
                  <div><dt>Networks</dt><dd>${escapeHTML(valueOrDash((detail && detail.networks) || container.networks))}</dd></div>
                  <div><dt>IPs</dt><dd>${escapeHTML(valueOrDash(detail && detail.ipAddresses && detail.ipAddresses.length ? detail.ipAddresses.join(', ') : null))}</dd></div>
                  <div><dt>Created</dt><dd>${escapeHTML(formatDateTime(detail && detail.created))}</dd></div>
                  <div><dt>Started</dt><dd>${escapeHTML(formatDateTime(detail && detail.startedAt))}</dd></div>
                </dl>
              </section>

              <section class="detail-card">
                <h3>Runtime</h3>
                <dl>
                  <div><dt>Command</dt><dd>${escapeHTML((detail && detail.command) || '-')}</dd></div>
                  <div><dt>Entrypoint</dt><dd>${escapeHTML((detail && detail.entrypoint) || '-')}</dd></div>
                  <div><dt>User</dt><dd>${escapeHTML((detail && detail.user) || '-')}</dd></div>
                  <div><dt>Working Dir</dt><dd>${escapeHTML((detail && detail.workingDir) || '-')}</dd></div>
                </dl>
              </section>

              <section class="detail-card detail-metrics">
                <h3>Resource Trends</h3>
                <div class="chart-grid">
                  <div class="chart-block">
                    <div class="chart-header"><span>CPU</span><span>${escapeHTML(container.cpu.toFixed(1))}%</span></div>
                    ${renderSparkline((history && history.cpu) || [], 100, 'cpu')}
                  </div>
                  <div class="chart-block">
                    <div class="chart-header"><span>MEM</span><span>${escapeHTML(container.memory.usage)} / ${escapeHTML(container.memory.limit)}</span></div>
                    ${renderSparkline((history && history.mem) || [], 100, 'mem')}
                  </div>
                  <div class="chart-block">
                    <div class="chart-header"><span>NET RX</span><span>${escapeHTML(container.netIO.rx || '-')}</span></div>
                    ${renderSparkline((history && history.netRx) || [], null, 'net')}
                  </div>
                  <div class="chart-block">
                    <div class="chart-header"><span>NET TX</span><span>${escapeHTML(container.netIO.tx || '-')}</span></div>
                    ${renderSparkline((history && history.netTx) || [], null, 'net-alt')}
                  </div>
                  <div class="chart-block">
                    <div class="chart-header"><span>IO READ</span><span>${escapeHTML(container.blockIO.read || '-')}</span></div>
                    ${renderSparkline((history && history.blockRead) || [], null, 'io')}
                  </div>
                  <div class="chart-block">
                    <div class="chart-header"><span>IO WRITE</span><span>${escapeHTML(container.blockIO.write || '-')}</span></div>
                    ${renderSparkline((history && history.blockWrite) || [], null, 'io-alt')}
                  </div>
                </div>
              </section>

              <section class="detail-card detail-env">
                <h3>Environment</h3>
                ${envSection}
              </section>
            </div>
          </div>
        </td>
      </tr>
    `;
  }

  function renderTable(filteredContainers) {
    if (state.loading) {
      els.tableContainer.innerHTML = `
        <div class="loading-state">
          <div class="loading-spinner"></div>
          <p>Gathering container stats.</p>
        </div>
      `;
      return;
    }

    if (filteredContainers.length === 0) {
      els.tableContainer.innerHTML = `
        <div class="empty-state">
          <p>No containers match your filters.</p>
        </div>
      `;
      return;
    }

    const rows = filteredContainers
      .map((container) => {
        const row = `
          <tr>
            <td>
              <div class="name-cell">
                <span class="state-indicator ${stateClassMap[container.state] || 'state-unknown'}"></span>
                <div class="name-stack">
                  <button class="name-button" type="button" data-action="toggle" data-id="${escapeHTML(container.id)}">
                    ${escapeHTML(container.name)}
                  </button>
                  <span class="subtle">${escapeHTML(container.raw.shortId)}</span>
                </div>
              </div>
            </td>
            <td>
              <div class="badge-stack">
                ${splitList(container.ports)
                  .map((item) => `<span class="net-badge">${escapeHTML(item)}</span>`)
                  .join('')}
              </div>
            </td>
            <td>
              <div class="badge-stack">
                ${splitList(container.networks)
                  .map((item) => `<span class="net-badge">${escapeHTML(item)}</span>`)
                  .join('')}
              </div>
            </td>
            <td>${renderUsageBar('cpu', container.cpu, `${container.cpu.toFixed(1)}%`)}</td>
            <td>${renderUsageBar('mem', container.memory.percent, `${container.memory.usage} / ${container.memory.limit}`)}</td>
            <td>
              <div class="badge-stack">
                <span class="net-badge">? ${escapeHTML(container.netIO.rx)}</span>
                <span class="net-badge">? ${escapeHTML(container.netIO.tx)}</span>
              </div>
            </td>
            <td>
              <div class="badge-stack">
                <span class="block-badge">R ${escapeHTML(container.blockIO.read)}</span>
                <span class="block-badge">W ${escapeHTML(container.blockIO.write)}</span>
              </div>
            </td>
            <td>${escapeHTML(container.pids)}</td>
            <td>${escapeHTML(container.uptime)}</td>
          </tr>
        `;
        if (state.selectedId === container.id) {
          return row + renderDetailRow(container);
        }
        return row;
      })
      .join('');

    els.tableContainer.innerHTML = `
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
          ${rows}
        </tbody>
      </table>
    `;
  }

  function render() {
    const filteredContainers = state.filterQuery
      ? state.containers.filter((container) => {
          const needle = state.filterQuery.trim().toLowerCase();
          return (
            container.name.toLowerCase().includes(needle) ||
            container.raw.shortId.toLowerCase().includes(needle) ||
            container.networks.toLowerCase().includes(needle)
          );
        })
      : state.containers;

    const runningCount = state.containers.filter((c) => c.state === 'running').length;

    els.containersCount.textContent = state.containers.length;
    els.runningCount.textContent = runningCount;
    els.updatedTime.textContent = formatTimestamp(state.lastUpdated);
    els.pauseButton.textContent = state.isPaused ? 'Resume Auto' : 'Pause Auto';

    if (state.error) {
      els.errorBanner.textContent = state.error;
      els.errorBanner.hidden = false;
    } else {
      els.errorBanner.hidden = true;
    }

    renderTable(filteredContainers);

    const refreshLabel = Math.round(state.refreshMs / 1000);
    els.footerNote.textContent = `Auto refresh ${state.isPaused ? 'paused' : `every ${refreshLabel}s`}${state.refreshing && !state.loading ? ' ú updating.' : ''}`;
  }

  function initControls() {
    REFRESH_OPTIONS.forEach((option) => {
      const item = document.createElement('option');
      item.value = option.value;
      item.textContent = `Every ${option.label}`;
      if (option.value === state.refreshMs) {
        item.selected = true;
      }
      els.refreshSelect.appendChild(item);
    });

    els.filterInput.addEventListener('input', (event) => {
      state.filterQuery = event.target.value;
      render();
    });

    els.refreshButton.addEventListener('click', () => loadContainers());

    els.pauseButton.addEventListener('click', () => {
      state.isPaused = !state.isPaused;
      startAutoRefresh();
      render();
    });

    els.refreshSelect.addEventListener('change', (event) => {
      state.refreshMs = Number(event.target.value);
      startAutoRefresh();
      render();
    });

    els.tableContainer.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const action = button.getAttribute('data-action');
      const id = button.getAttribute('data-id');

      if (action === 'toggle' && id) {
        if (state.selectedId === id) {
          state.selectedId = null;
          state.detailError = null;
          render();
        } else {
          state.selectedId = id;
          state.detailError = null;
          if (!state.detailById[id]) {
            loadDetail(id);
          } else {
            render();
          }
        }
      }

      if (action === 'refresh-detail' && id) {
        loadDetail(id);
      }

      if (action === 'close-detail') {
        state.selectedId = null;
        state.detailError = null;
        render();
      }
    });
  }

  initControls();
  loadContainers();
  startAutoRefresh();
})();
