package main

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func saveConfig(t *testing.T, dir, listen, frpc string) string {
	t.Helper()
	data, err := json.Marshal(Config{Listen: listen, Token: strings.Repeat("0", 64), Scopes: []string{"127.0.0.1"}, Frpc: frpc})
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "connector.json")
	if err = os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	return file
}
func TestSpawnFailureClosesListener(t *testing.T) {
	probe, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	addr := probe.Addr().String()
	probe.Close()
	dir := t.TempDir()
	file := saveConfig(t, dir, addr, filepath.Join(dir, "missing-frpc"))
	if err := runConnector(file, make(chan os.Signal)); err == nil {
		t.Fatal("spawn failure reported success")
	}
	reopened, e := net.Listen("tcp", addr)
	if e != nil {
		t.Fatal("failed launch leaked listener:", e)
	}
	reopened.Close()
}
func TestConnectorCLIExitAndCancellation(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("POSIX process fixture")
	}
	root := t.TempDir()
	binary := filepath.Join(root, "wormhole-connector")
	build := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-o", binary, ".")
	if out, e := build.CombinedOutput(); e != nil {
		t.Fatalf("build: %v %s", e, out)
	}
	for _, mode := range []string{"missing-config", "missing-runtime", "child-exit-zero", "child-exit-error"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			file := filepath.Join(dir, "missing.json")
			if mode != "missing-config" {
				frpc := filepath.Join(dir, "frpc")
				if strings.HasPrefix(mode, "child-exit") {
					exit := "0"
					if mode == "child-exit-error" {
						exit = "7"
					}
					os.WriteFile(frpc, []byte("#!/bin/sh\nexit "+exit+"\n"), 0700)
				}
				file = saveConfig(t, dir, "127.0.0.1:0", frpc)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, binary, "-config", file)
			out, err := command.CombinedOutput()
			if ctx.Err() != nil {
				t.Fatal("failed startup hung")
			}
			if err == nil {
				t.Fatalf("failure exited zero: %s", out)
			}
			if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 1 {
				t.Fatalf("unexpected exit: %v %s", err, out)
			}
		})
	}
	t.Run("stop-reaps-child", func(t *testing.T) {
		dir := t.TempDir()
		pidfile := filepath.Join(dir, "child.pid")
		frpc := filepath.Join(dir, "frpc")
		os.WriteFile(frpc, []byte("#!/bin/sh\nprintf '%s' \"$$\" > "+strconv.Quote(pidfile)+"\nexec sleep 30\n"), 0700)
		file := saveConfig(t, dir, "127.0.0.1:0", frpc)
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, binary, "-config", file)
		if e := command.Start(); e != nil {
			t.Fatal(e)
		}
		defer command.Process.Kill()
		var pid int
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if data, e := os.ReadFile(pidfile); e == nil {
				pid, _ = strconv.Atoi(string(data))
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		if pid == 0 {
			t.Fatal("child not started")
		}
		defer syscall.Kill(pid, syscall.SIGKILL)
		command.Process.Signal(syscall.SIGTERM)
		if e := command.Wait(); e != nil {
			t.Fatal("intentional stop failed:", e)
		}
		if e := syscall.Kill(pid, 0); e != syscall.ESRCH {
			t.Fatalf("child still exists after stop: %v", e)
		}
	})
}
