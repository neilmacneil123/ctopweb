export interface ContainerMetrics {
  usage: string;
  limit: string;
  percent: number;
}

export interface IOStats {
  rx?: string;
  tx?: string;
  read?: string;
  write?: string;
}

export interface ContainerInfo {
  id: string;
  name: string;
  state: string;
  ports: string;
  networks: string;
  cpu: number;
  memory: ContainerMetrics;
  netIO: Required<Pick<IOStats, 'rx' | 'tx'>>;
  blockIO: Required<Pick<IOStats, 'read' | 'write'>>;
  pids: number;
  uptime: string;
  raw: {
    shortId: string;
  };
}

export interface ContainerResponse {
  containers: ContainerInfo[];
  fetchedAt: string;
}
