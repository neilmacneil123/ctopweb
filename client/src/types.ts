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

export interface IOBytes {
  rx: number;
  tx: number;
}

export interface BlockIOBytes {
  read: number;
  write: number;
}

export interface EnvVar {
  key: string;
  value: string;
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
  netIOBytes: IOBytes;
  blockIO: Required<Pick<IOStats, 'read' | 'write'>>;
  blockIOBytes: BlockIOBytes;
  pids: number;
  uptime: string;
  raw: {
    shortId: string;
  };
}

export interface ContainerDetail {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  created: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  health: string;
  restartCount: number;
  pid: number;
  ports: string;
  networks: string;
  ipAddresses: string[];
  command: string;
  entrypoint: string;
  workingDir: string;
  user: string;
  env: EnvVar[];
  labels: Record<string, string>;
}

export interface ContainerResponse {
  containers: ContainerInfo[];
  fetchedAt: string;
}
