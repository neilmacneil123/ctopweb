const express = require('express');
const Docker = require('dockerode');
const cors = require('cors');

const app = express();
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
const PORT = process.env.PORT || 4000;

app.use(cors());

const formatBytes = (bytes) => {
  if (!bytes && bytes !== 0) return '-';
  if (bytes === 0) return '0B';
  const units = ['B', 'K', 'M', 'G', 'T'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)}${units[i]}`;
};

const formatDuration = (start) => {
  if (!start) return '-';
  const startTime = new Date(start).getTime();
  if (Number.isNaN(startTime)) return '-';
  const diff = Date.now() - startTime;
  if (diff < 0) return '-';
  const seconds = Math.floor(diff / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (days > 0) return `${days}d${hours}h${minutes}m`;
  if (hours > 0) return `${hours}h${minutes}m${secs}s`;
  if (minutes > 0) return `${minutes}m${secs}s`;
  return `${secs}s`;
};

const cpuPercent = (stats) => {
  if (!stats || !stats.precpu_stats || !stats.cpu_stats) return 0;
  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
  const cores = stats.cpu_stats.online_cpus || (stats.cpu_stats.cpu_usage.percpu_usage ? stats.cpu_stats.cpu_usage.percpu_usage.length : 1);
  if (cpuDelta > 0 && systemDelta > 0) {
    return (cpuDelta / systemDelta) * cores * 100;
  }
  return 0;
};

const memoryUsage = (stats) => {
  if (!stats || !stats.memory_stats) {
    return { usage: 0, limit: 0, percent: 0 };
  }
  const cache = stats.memory_stats.stats && stats.memory_stats.stats.cache ? stats.memory_stats.stats.cache : 0;
  const usage = Math.max(stats.memory_stats.usage - cache, 0);
  const limit = stats.memory_stats.limit || 0;
  const percent = limit ? (usage / limit) * 100 : 0;
  return { usage, limit, percent };
};

const networkIO = (stats) => {
  if (!stats || !stats.networks) return { rx: 0, tx: 0 };
  return Object.values(stats.networks).reduce(
    (acc, nic) => ({ rx: acc.rx + (nic.rx_bytes || 0), tx: acc.tx + (nic.tx_bytes || 0) }),
    { rx: 0, tx: 0 }
  );
};

const blockIO = (stats) => {
  if (!stats || !stats.blkio_stats || !Array.isArray(stats.blkio_stats.io_service_bytes_recursive)) {
    return { read: 0, write: 0 };
  }
  return stats.blkio_stats.io_service_bytes_recursive.reduce((acc, entry) => {
    if (entry.op === 'Read') acc.read += entry.value;
    if (entry.op === 'Write') acc.write += entry.value;
    return acc;
  }, { read: 0, write: 0 });
};

const formatPorts = (ports) => {
  if (!ports || ports.length === 0) return '-';
  return ports
    .map((port) => {
      const proto = port.Type ? port.Type.toLowerCase() : 'tcp';
      const container = `${port.PrivatePort}/${proto}`;
      if (port.PublicPort) {
        const host = port.IP && port.IP !== '0.0.0.0' ? port.IP : '0.0.0.0';
        return `${host}:${port.PublicPort} -> ${container}`;
      }
      return container;
    })
    .join(', ');
};

const formatNetworks = (networkSettings) => {
  if (!networkSettings || !networkSettings.Networks) return '-';
  const entries = Object.entries(networkSettings.Networks).map(([name, info]) => `${name}:${info.IPAddress || '0.0.0.0'}`);
  return entries.length ? entries.join(', ') : '-';
};

const formatPortsFromInspect = (portMap) => {
  if (!portMap || Object.keys(portMap).length === 0) return '-';
  const entries = Object.entries(portMap).flatMap(([containerPort, bindings]) => {
    if (!bindings || bindings.length === 0) {
      return containerPort;
    }
    return bindings.map((binding) => {
      const host = binding.HostIp && binding.HostIp !== '' ? binding.HostIp : '0.0.0.0';
      return `${host}:${binding.HostPort} -> ${containerPort}`;
    });
  });
  return entries.length ? entries.join(', ') : '-';
};

const containerState = (inspectData) => {
  if (!inspectData || !inspectData.State) return 'unknown';
  if (inspectData.State.Paused) return 'paused';
  if (inspectData.State.Restarting) return 'restarting';
  if (inspectData.State.Running) return 'running';
  return 'stopped';
};

const formatEnvVars = (envList) => {
  if (!Array.isArray(envList)) return [];
  return envList.map((entry) => {
    const idx = entry.indexOf('=');
    if (idx === -1) return { key: entry, value: '' };
    return { key: entry.slice(0, idx), value: entry.slice(idx + 1) };
  });
};

async function buildContainerPayload(containerInfo) {
  const container = docker.getContainer(containerInfo.Id);
  let stats = null;
  let inspectInfo = null;

  try {
    [inspectInfo, stats] = await Promise.all([
      container.inspect(),
      container.stats({ stream: false })
    ]);
  } catch (err) {
    try {
      inspectInfo = inspectInfo || (await container.inspect());
    } catch (inspectErr) {
      // ignore inspect errors to still return base info
    }
  }

  const cpu = cpuPercent(stats);
  const mem = memoryUsage(stats);
  const net = networkIO(stats);
  const blk = blockIO(stats);
  const pids = (stats && stats.pids_stats && stats.pids_stats.current) || (inspectInfo && inspectInfo.State && inspectInfo.State.Pid) || 0;
  const uptime = inspectInfo ? formatDuration(inspectInfo.State && inspectInfo.State.StartedAt) : '-';
  const networks = inspectInfo ? formatNetworks(inspectInfo.NetworkSettings) : '-';

  return {
    id: containerInfo.Id,
    name: (containerInfo.Names && containerInfo.Names[0]) ? containerInfo.Names[0].replace(/^\//, '') : containerInfo.Id.substring(0, 12),
    state: containerState(inspectInfo),
    ports: formatPorts(containerInfo.Ports),
    networks,
    cpu: Number(cpu.toFixed(1)),
    memory: {
      usage: formatBytes(mem.usage),
      limit: formatBytes(mem.limit),
      percent: Number(mem.percent.toFixed(1))
    },
    netIO: {
      rx: formatBytes(net.rx),
      tx: formatBytes(net.tx)
    },
    netIOBytes: {
      rx: net.rx,
      tx: net.tx
    },
    blockIO: {
      read: formatBytes(blk.read),
      write: formatBytes(blk.write)
    },
    blockIOBytes: {
      read: blk.read,
      write: blk.write
    },
    pids,
    uptime,
    raw: {
      shortId: containerInfo.Id.substring(0, 12)
    }
  };
}

app.get('/api/containers', async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    const payload = await Promise.all(containers.map(buildContainerPayload));
    res.json({ containers: payload, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Failed to fetch container stats', err);
    res.status(500).json({ message: 'Unable to fetch container data', error: err.message });
  }
});

app.get('/api/containers/:id', async (req, res) => {
  try {
    const container = docker.getContainer(req.params.id);
    const inspectInfo = await container.inspect();
    const state = inspectInfo.State || {};
    const config = inspectInfo.Config || {};
    const networks = inspectInfo.NetworkSettings || {};
    const ipAddresses = networks.Networks ? Object.values(networks.Networks).map((info) => info.IPAddress || '0.0.0.0') : [];

    res.json({
      id: inspectInfo.Id,
      name: inspectInfo.Name ? inspectInfo.Name.replace(/^\//, '') : inspectInfo.Id.substring(0, 12),
      image: config.Image || '-',
      state: containerState(inspectInfo),
      status: state.Status || 'unknown',
      created: inspectInfo.Created || null,
      startedAt: state.StartedAt || null,
      finishedAt: state.FinishedAt || null,
      health: state.Health && state.Health.Status ? state.Health.Status : '-',
      restartCount: inspectInfo.RestartCount || 0,
      pid: state.Pid || 0,
      ports: formatPortsFromInspect(networks.Ports),
      networks: formatNetworks(networks),
      ipAddresses,
      command: Array.isArray(config.Cmd) && config.Cmd.length ? config.Cmd.join(' ') : '-',
      entrypoint: Array.isArray(config.Entrypoint) && config.Entrypoint.length ? config.Entrypoint.join(' ') : '-',
      workingDir: config.WorkingDir || '-',
      user: config.User || '-',
      env: formatEnvVars(config.Env),
      labels: config.Labels || {}
    });
  } catch (err) {
    console.error('Failed to fetch container detail', err);
    res.status(500).json({ message: 'Unable to fetch container detail', error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`ctop web server listening on http://localhost:${PORT}`);
});
