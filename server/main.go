package main

import (
	"context"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/docker/go-connections/nat"
)

type ContainerMetrics struct {
	Usage   string  `json:"usage"`
	Limit   string  `json:"limit"`
	Percent float64 `json:"percent"`
}

type IOStats struct {
	Rx   string `json:"rx,omitempty"`
	Tx   string `json:"tx,omitempty"`
	Read string `json:"read,omitempty"`
	Write string `json:"write,omitempty"`
}

type IOBytes struct {
	Rx uint64 `json:"rx"`
	Tx uint64 `json:"tx"`
}

type BlockIOBytes struct {
	Read  uint64 `json:"read"`
	Write uint64 `json:"write"`
}

type ContainerInfo struct {
	ID           string           `json:"id"`
	Name         string           `json:"name"`
	State        string           `json:"state"`
	Ports        string           `json:"ports"`
	Networks     string           `json:"networks"`
	CPU          float64          `json:"cpu"`
	Memory       ContainerMetrics `json:"memory"`
	NetIO        IOStats          `json:"netIO"`
	NetIOBytes   IOBytes          `json:"netIOBytes"`
	BlockIO      IOStats          `json:"blockIO"`
	BlockIOBytes BlockIOBytes     `json:"blockIOBytes"`
	Pids         uint64           `json:"pids"`
	Uptime       string           `json:"uptime"`
	Raw          struct {
		ShortID string `json:"shortId"`
	} `json:"raw"`
}

type EnvVar struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type ContainerDetail struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Image        string            `json:"image"`
	State        string            `json:"state"`
	Status       string            `json:"status"`
	Created      *string           `json:"created"`
	StartedAt    *string           `json:"startedAt"`
	FinishedAt   *string           `json:"finishedAt"`
	Health       string            `json:"health"`
	RestartCount int               `json:"restartCount"`
	Pid          int               `json:"pid"`
	Ports        string            `json:"ports"`
	Networks     string            `json:"networks"`
	IPAddresses  []string          `json:"ipAddresses"`
	Command      string            `json:"command"`
	Entrypoint   string            `json:"entrypoint"`
	WorkingDir   string            `json:"workingDir"`
	User         string            `json:"user"`
	Env          []EnvVar          `json:"env"`
	Labels       map[string]string `json:"labels"`
}

type ContainerResponse struct {
	Containers []ContainerInfo `json:"containers"`
	FetchedAt  string          `json:"fetchedAt"`
}

func main() {
	port := getEnvDefault("PORT", "4000")
	socketPath := getEnvDefault("DOCKER_SOCKET", "/var/run/docker.sock")

	cli, err := client.NewClientWithOpts(
		client.WithHost("unix://"+socketPath),
		client.WithAPIVersionNegotiation(),
	)
	if err != nil {
		log.Fatalf("failed to create docker client: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/containers", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"message": "Method not allowed"})
			return
		}
		handleContainers(w, r, cli)
	})
	mux.HandleFunc("/api/containers/", func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/containers/")
		path = strings.TrimPrefix(path, "/")
		if path == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"message": "Missing container id"})
			return
		}
		parts := strings.Split(path, "/")
		id := parts[0]
		if len(parts) == 1 {
			if r.Method != http.MethodGet {
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"message": "Method not allowed"})
				return
			}
			handleContainerDetail(w, r, cli)
			return
		}

		action := parts[1]
		switch action {
		case "start", "stop", "restart":
			if r.Method != http.MethodPost {
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"message": "Method not allowed"})
				return
			}
			handleContainerAction(w, r, cli, id, action)
		case "logs":
			if r.Method != http.MethodGet {
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"message": "Method not allowed"})
				return
			}
			handleContainerLogs(w, r, cli, id)
		case "exec":
			if r.Method != http.MethodPost {
				writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"message": "Method not allowed"})
				return
			}
			handleContainerExec(w, r, cli, id)
		default:
			writeJSON(w, http.StatusNotFound, map[string]string{"message": "Unknown container action"})
		}
	})
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"ok":        true,
			"timestamp": time.Now().Format(time.RFC3339),
		})
	})

	handler := withCORS(mux)
	server := &http.Server{
		Addr:              ":" + port,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("ctop web server listening on http://localhost:%s", port)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server error: %v", err)
	}
}

func handleContainers(w http.ResponseWriter, r *http.Request, cli *client.Client) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	containers, err := cli.ContainerList(ctx, types.ContainerListOptions{All: true})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"message": "Unable to fetch container data",
			"error":   err.Error(),
		})
		return
	}

	results := make([]ContainerInfo, len(containers))
	errs := make([]error, len(containers))
	sem := make(chan struct{}, 6)
	var wg sync.WaitGroup

	for i, info := range containers {
		wg.Add(1)
		sem <- struct{}{}
		go func(idx int, containerInfo types.Container) {
			defer wg.Done()
			defer func() { <-sem }()
			payload, err := buildContainerPayload(r.Context(), cli, containerInfo)
			results[idx] = payload
			errs[idx] = err
		}(i, info)
	}

	wg.Wait()

	for _, err := range errs {
		if err != nil {
			log.Printf("container payload error: %v", err)
		}
	}

	writeJSON(w, http.StatusOK, ContainerResponse{
		Containers: results,
		FetchedAt:  time.Now().Format(time.RFC3339),
	})
}

func handleContainerDetail(w http.ResponseWriter, r *http.Request, cli *client.Client) {
	id := strings.TrimPrefix(r.URL.Path, "/api/containers/")
	if id == "" || id == "/api/containers" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "Missing container id"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	inspectInfo, err := cli.ContainerInspect(ctx, id)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"message": "Unable to fetch container detail",
			"error":   err.Error(),
		})
		return
	}

	state := inspectInfo.State
	if state == nil {
		state = &types.ContainerState{}
	}
	config := inspectInfo.Config
	if config == nil {
		config = &container.Config{}
	}
	networks := inspectInfo.NetworkSettings

	var ipAddresses []string
	if networks != nil && networks.Networks != nil {
		for _, info := range networks.Networks {
			if info.IPAddress != "" {
				ipAddresses = append(ipAddresses, info.IPAddress)
			} else {
				ipAddresses = append(ipAddresses, "0.0.0.0")
			}
		}
	}

	ports := "-"
	if networks != nil {
		ports = formatPortsFromInspect(networks.Ports)
	}

	response := ContainerDetail{
		ID:           inspectInfo.ID,
		Name:         trimContainerName(inspectInfo.Name, inspectInfo.ID),
		Image:        safeString(config.Image, "-"),
		State:        containerState(&inspectInfo),
		Status:       safeString(state.Status, "unknown"),
		Created:      optionalString(inspectInfo.Created),
		StartedAt:    optionalString(state.StartedAt),
		FinishedAt:   optionalString(state.FinishedAt),
		Health:       healthStatus(state),
		RestartCount: inspectInfo.RestartCount,
		Pid:          state.Pid,
		Ports:        ports,
		Networks:     formatNetworks(networks),
		IPAddresses:  ipAddresses,
		Command:      joinCommand(config.Cmd),
		Entrypoint:   joinCommand(config.Entrypoint),
		WorkingDir:   safeString(config.WorkingDir, "-"),
		User:         safeString(config.User, "-"),
		Env:          formatEnvVars(config.Env),
		Labels:       config.Labels,
	}

	writeJSON(w, http.StatusOK, response)
}

func handleContainerAction(w http.ResponseWriter, r *http.Request, cli *client.Client, id, action string) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	switch action {
	case "start":
		if err := cli.ContainerStart(ctx, id, container.StartOptions{}); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"message": "Unable to start container",
				"error":   err.Error(),
			})
			return
		}
	case "stop":
		timeout := 10
		if err := cli.ContainerStop(ctx, id, container.StopOptions{Timeout: &timeout}); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"message": "Unable to stop container",
				"error":   err.Error(),
			})
			return
		}
	case "restart":
		timeout := 10
		if err := cli.ContainerRestart(ctx, id, container.StopOptions{Timeout: &timeout}); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"message": "Unable to restart container",
				"error":   err.Error(),
			})
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func handleContainerLogs(w http.ResponseWriter, r *http.Request, cli *client.Client, id string) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	query := r.URL.Query()
	tail := query.Get("tail")
	if tail == "" {
		tail = "200"
	}
	since := query.Get("since")
	timestamps := query.Get("timestamps") == "1"

	reader, err := cli.ContainerLogs(ctx, id, container.LogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Timestamps: timestamps,
		Tail:       tail,
		Since:      since,
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"message": "Unable to fetch logs",
			"error":   err.Error(),
		})
		return
	}
	defer reader.Close()

	var output bytes.Buffer
	if _, err := stdcopy.StdCopy(&output, &output, reader); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"message": "Unable to read logs",
			"error":   err.Error(),
		})
		return
	}

	data := output.Bytes()
	writeJSON(w, http.StatusOK, map[string]string{"logs": string(data)})
}

type execRequest struct {
	Command string `json:"command"`
	User    string `json:"user"`
	WorkDir string `json:"workDir"`
}

func handleContainerExec(w http.ResponseWriter, r *http.Request, cli *client.Client, id string) {
	var payload execRequest
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"message": "Invalid request body"})
		return
	}

	command := strings.TrimSpace(payload.Command)
	cmd := []string{"/bin/sh"}
	if command != "" {
		cmd = []string{"/bin/sh", "-lc", command}
	}

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	execResp, err := cli.ContainerExecCreate(ctx, id, types.ExecConfig{
		Cmd:          cmd,
		AttachStdout: true,
		AttachStderr: true,
		Tty:          false,
		User:         payload.User,
		WorkingDir:   payload.WorkDir,
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"message": "Unable to start exec session",
			"error":   err.Error(),
		})
		return
	}

	attach, err := cli.ContainerExecAttach(ctx, execResp.ID, types.ExecStartCheck{Tty: false})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"message": "Unable to attach exec session",
			"error":   err.Error(),
		})
		return
	}
	defer attach.Close()

	var execOutput bytes.Buffer
	if _, err := stdcopy.StdCopy(&execOutput, &execOutput, attach.Reader); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"message": "Unable to read exec output",
			"error":   err.Error(),
		})
		return
	}

	inspect, err := cli.ContainerExecInspect(ctx, execResp.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"message": "Unable to inspect exec session",
			"error":   err.Error(),
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"output":   execOutput.String(),
		"exitCode": inspect.ExitCode,
	})
}

func buildContainerPayload(ctx context.Context, cli *client.Client, info types.Container) (ContainerInfo, error) {
	containerCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()

	shortID := info.ID
	if len(shortID) > 12 {
		shortID = shortID[:12]
	}

	payload := ContainerInfo{
		ID:       info.ID,
		Name:     trimContainerName(nameFromList(info.Names), info.ID),
		State:    info.State,
		Ports:    formatPorts(info.Ports),
		Networks: "-",
		CPU:      0,
		Memory: ContainerMetrics{
			Usage:   "0B",
			Limit:   "0B",
			Percent: 0,
		},
		NetIO: IOStats{
			Rx: "0B",
			Tx: "0B",
		},
		NetIOBytes: IOBytes{},
		BlockIO: IOStats{
			Read:  "0B",
			Write: "0B",
		},
		BlockIOBytes: BlockIOBytes{},
		Pids:         0,
		Uptime:       "-",
	}
	payload.Raw.ShortID = shortID

	var (
		inspectInfo *types.ContainerJSON
		stats       *types.StatsJSON
		inspectErr  error
		statsErr    error
	)

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		inspect, err := cli.ContainerInspect(containerCtx, info.ID)
		if err != nil {
			inspectErr = err
			return
		}
		inspectInfo = &inspect
	}()

	go func() {
		defer wg.Done()
		statsData, err := fetchStats(containerCtx, cli, info.ID)
		if err != nil {
			statsErr = err
			return
		}
		stats = statsData
	}()

	wg.Wait()

	if inspectErr != nil && statsErr != nil {
		return payload, fmt.Errorf("inspect error: %v; stats error: %v", inspectErr, statsErr)
	}

	if inspectInfo != nil {
		payload.State = containerState(inspectInfo)
		payload.Uptime = formatDuration(inspectInfo.State.StartedAt)
		payload.Networks = formatNetworks(inspectInfo.NetworkSettings)
	}

	if stats != nil {
		payload.CPU = roundTo(cpuPercent(stats), 1)
		memUsage, memLimit, memPercent := memoryUsage(stats)
		payload.Memory = ContainerMetrics{
			Usage:   formatBytes(memUsage),
			Limit:   formatBytes(memLimit),
			Percent: roundTo(memPercent, 1),
		}
		rx, tx := networkIO(stats)
		payload.NetIO = IOStats{
			Rx: formatBytes(rx),
			Tx: formatBytes(tx),
		}
		payload.NetIOBytes = IOBytes{Rx: rx, Tx: tx}
		read, write := blockIO(stats)
		payload.BlockIO = IOStats{
			Read:  formatBytes(read),
			Write: formatBytes(write),
		}
		payload.BlockIOBytes = BlockIOBytes{Read: read, Write: write}
		if stats.PidsStats.Current > 0 {
			payload.Pids = stats.PidsStats.Current
		}
	}

	if payload.Pids == 0 && inspectInfo != nil && inspectInfo.State != nil {
		payload.Pids = uint64(inspectInfo.State.Pid)
	}

	return payload, nil
}

func fetchStats(ctx context.Context, cli *client.Client, id string) (*types.StatsJSON, error) {
	statsCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	resp, err := cli.ContainerStats(statsCtx, id, false)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var stats types.StatsJSON
	if err := json.NewDecoder(resp.Body).Decode(&stats); err != nil {
		return nil, err
	}
	return &stats, nil
}

func cpuPercent(stats *types.StatsJSON) float64 {
	if stats == nil {
		return 0
	}
	cpuDelta := float64(stats.CPUStats.CPUUsage.TotalUsage - stats.PreCPUStats.CPUUsage.TotalUsage)
	systemDelta := float64(stats.CPUStats.SystemUsage - stats.PreCPUStats.SystemUsage)
	cores := float64(stats.CPUStats.OnlineCPUs)
	if cores == 0 && len(stats.CPUStats.CPUUsage.PercpuUsage) > 0 {
		cores = float64(len(stats.CPUStats.CPUUsage.PercpuUsage))
	}
	if cpuDelta > 0 && systemDelta > 0 && cores > 0 {
		return (cpuDelta / systemDelta) * cores * 100
	}
	return 0
}

func memoryUsage(stats *types.StatsJSON) (uint64, uint64, float64) {
	if stats == nil {
		return 0, 0, 0
	}
	usage := stats.MemoryStats.Usage
	limit := stats.MemoryStats.Limit
	cache := uint64(0)
	if stats.MemoryStats.Stats != nil {
		if value, ok := stats.MemoryStats.Stats["cache"]; ok {
			cache = value
		}
	}
	if usage > cache {
		usage -= cache
	}
	percent := 0.0
	if limit > 0 {
		percent = (float64(usage) / float64(limit)) * 100
	}
	return usage, limit, percent
}

func networkIO(stats *types.StatsJSON) (uint64, uint64) {
	if stats == nil || stats.Networks == nil {
		return 0, 0
	}
	var rx, tx uint64
	for _, nic := range stats.Networks {
		rx += nic.RxBytes
		tx += nic.TxBytes
	}
	return rx, tx
}

func blockIO(stats *types.StatsJSON) (uint64, uint64) {
	if stats == nil {
		return 0, 0
	}
	var read, write uint64
	for _, entry := range stats.BlkioStats.IoServiceBytesRecursive {
		switch strings.ToLower(entry.Op) {
		case "read":
			read += entry.Value
		case "write":
			write += entry.Value
		}
	}
	return read, write
}

func formatBytes(bytes uint64) string {
	if bytes == 0 {
		return "0B"
	}
	units := []string{"B", "K", "M", "G", "T"}
	k := 1024.0
	value := float64(bytes)
	i := int(math.Floor(math.Log(value) / math.Log(k)))
	if i < 0 {
		i = 0
	}
	if i >= len(units) {
		i = len(units) - 1
	}
	value = value / math.Pow(k, float64(i))
	precision := 1
	if value >= 10 || i == 0 {
		precision = 0
	}
	format := "%." + strconv.Itoa(precision) + "f%s"
	return fmt.Sprintf(format, value, units[i])
}

func formatDuration(start string) string {
	if start == "" {
		return "-"
	}
	parsed, err := time.Parse(time.RFC3339Nano, start)
	if err != nil {
		return "-"
	}
	diff := time.Since(parsed)
	if diff < 0 {
		return "-"
	}
	seconds := int(diff.Seconds())
	days := seconds / 86400
	hours := (seconds % 86400) / 3600
	minutes := (seconds % 3600) / 60
	secs := seconds % 60

	if days > 0 {
		return fmt.Sprintf("%dd%dh%dm", days, hours, minutes)
	}
	if hours > 0 {
		return fmt.Sprintf("%dh%dm%ds", hours, minutes, secs)
	}
	if minutes > 0 {
		return fmt.Sprintf("%dm%ds", minutes, secs)
	}
	return fmt.Sprintf("%ds", secs)
}

func formatPorts(ports []types.Port) string {
	if len(ports) == 0 {
		return "-"
	}
	parts := make([]string, 0, len(ports))
	for _, port := range ports {
		proto := port.Type
		if proto == "" {
			proto = "tcp"
		}
		container := fmt.Sprintf("%d/%s", port.PrivatePort, strings.ToLower(proto))
		if port.PublicPort > 0 {
			host := port.IP
			if host == "" || host == "0.0.0.0" {
				host = "0.0.0.0"
			}
			parts = append(parts, fmt.Sprintf("%s:%d -> %s", host, port.PublicPort, container))
		} else {
			parts = append(parts, container)
		}
	}
	return strings.Join(parts, ", ")
}

func formatNetworks(networkSettings *types.NetworkSettings) string {
	if networkSettings == nil || networkSettings.Networks == nil || len(networkSettings.Networks) == 0 {
		return "-"
	}
	entries := make([]string, 0, len(networkSettings.Networks))
	for name, info := range networkSettings.Networks {
		ip := info.IPAddress
		if ip == "" {
			ip = "0.0.0.0"
		}
		entries = append(entries, fmt.Sprintf("%s:%s", name, ip))
	}
	if len(entries) == 0 {
		return "-"
	}
	return strings.Join(entries, ", ")
}

func formatPortsFromInspect(portMap nat.PortMap) string {
	if portMap == nil || len(portMap) == 0 {
		return "-"
	}
	var entries []string
	for containerPort, bindings := range portMap {
		if len(bindings) == 0 {
			entries = append(entries, string(containerPort))
			continue
		}
		for _, binding := range bindings {
			host := binding.HostIP
			if host == "" {
				host = "0.0.0.0"
			}
			entries = append(entries, fmt.Sprintf("%s:%s -> %s", host, binding.HostPort, containerPort))
		}
	}
	if len(entries) == 0 {
		return "-"
	}
	return strings.Join(entries, ", ")
}

func containerState(inspect *types.ContainerJSON) string {
	if inspect == nil || inspect.State == nil {
		return "unknown"
	}
	if inspect.State.Paused {
		return "paused"
	}
	if inspect.State.Restarting {
		return "restarting"
	}
	if inspect.State.Running {
		return "running"
	}
	return "stopped"
}

func formatEnvVars(envList []string) []EnvVar {
	if len(envList) == 0 {
		return []EnvVar{}
	}
	out := make([]EnvVar, 0, len(envList))
	for _, entry := range envList {
		if entry == "" {
			continue
		}
		parts := strings.SplitN(entry, "=", 2)
		if len(parts) == 1 {
			out = append(out, EnvVar{Key: parts[0], Value: ""})
			continue
		}
		out = append(out, EnvVar{Key: parts[0], Value: parts[1]})
	}
	return out
}

func joinCommand(values []string) string {
	if len(values) == 0 {
		return "-"
	}
	return strings.Join(values, " ")
}

func optionalString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func safeString(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func nameFromList(names []string) string {
	if len(names) == 0 {
		return ""
	}
	return names[0]
}

func trimContainerName(name string, fallbackID string) string {
	if name == "" {
		if len(fallbackID) > 12 {
			return fallbackID[:12]
		}
		return fallbackID
	}
	return strings.TrimPrefix(name, "/")
}

func healthStatus(state *types.ContainerState) string {
	if state == nil || state.Health == nil || state.Health.Status == "" {
		return "-"
	}
	return state.Health.Status
}

func getEnvDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func roundTo(value float64, places int) float64 {
	if places <= 0 {
		return math.Round(value)
	}
	pow := math.Pow(10, float64(places))
	return math.Round(value*pow) / pow
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "")
	if err := encoder.Encode(payload); err != nil {
		log.Printf("failed to write json response: %v", err)
	}
}
