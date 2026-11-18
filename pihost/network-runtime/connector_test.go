package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestBundledExecutableDoesNotDependOnPATH(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is Linux only")
	}
	bundle := t.TempDir()
	if err := os.WriteFile(filepath.Join(bundle, "frpc"), []byte("#!/bin/sh\nprintf 'BUNDLED_RUNTIME:%s:%s' \"$PWD\" \"$2\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	config, executable, err := connectorExecutable(filepath.Join(bundle, "connector.json"), "frpc")
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(executable, "-c", filepath.Join(filepath.Dir(config), "frpc.toml"))
	child.Dir = filepath.Dir(config)
	child.Env = []string{"PATH=/nonexistent"}
	out, err := child.CombinedOutput()
	if err != nil {
		t.Fatalf("%v %s", err, out)
	}
	if !strings.Contains(string(out), "BUNDLED_RUNTIME:"+bundle+":"+filepath.Join(bundle, "frpc.toml")) {
		t.Fatalf("wrong runtime location: %s", out)
	}
}
func TestBareConfigPathResolvesToAbsoluteBundle(t *testing.T) {
	config, exe, err := connectorExecutable("connector.json", "frpc")
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(config) || !filepath.IsAbs(exe) || filepath.Dir(config) != filepath.Dir(exe) {
		t.Fatal("bundle paths must be absolute")
	}
}
func TestExplicitExecutableOverrideIsPreserved(t *testing.T) {
	expected := filepath.Join(t.TempDir(), "custom-frpc")
	_, exe, err := connectorExecutable("connector.json", expected)
	if err != nil || exe != expected {
		t.Fatal("absolute override lost")
	}
}
