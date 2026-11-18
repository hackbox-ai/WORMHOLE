package main

import (
	"strings"
	"testing"
)

func TestKernelObjectNamesFitPlatformLimits(t *testing.T) {
	if len(forwardGuard) > 28 {
		t.Fatalf("iptables chain exceeds its 28-byte limit: %s", forwardGuard)
	}
	name := tunnelName(0xffff, 0xffff)
	if len(name) > 15 {
		t.Fatalf("TUN name exceeds IFNAMSIZ: %s", name)
	}
	if !strings.HasPrefix(name, tunnelPrefix) || len(name) != len(tunnelPrefix)+8 {
		t.Fatalf("cleanup ownership no longer recognizes generated interfaces: %s", name)
	}
	if tunnelName(0xffff, 1) == tunnelName(0xffff, 2) {
		t.Fatal("independent packet sessions must have distinct names")
	}
}
