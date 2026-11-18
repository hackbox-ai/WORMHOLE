package main

import (
	"encoding/json"
	"fmt"
	"golang.org/x/sys/unix"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

func run(cmd string, args ...string) error { r := exec.Command(cmd, args...); return r.Run() }

const forwardGuard = "WORMHOLE_FWD_GUARD"

func guard(tool string, enable bool) error {
	if enable {
		if run(tool, "-w", "5", "-t", "filter", "-N", forwardGuard) != nil {
			if run(tool, "-w", "5", "-C", forwardGuard, "-j", "DROP") != nil {
				return fmt.Errorf("forwarding guard conflict")
			}
		} else if e := run(tool, "-w", "5", "-A", forwardGuard, "-j", "DROP"); e != nil {
			return e
		}
		if run(tool, "-w", "5", "-C", "FORWARD", "-j", forwardGuard) != nil {
			return run(tool, "-w", "5", "-I", "FORWARD", "-j", forwardGuard)
		}
	} else {
		run(tool, "-w", "5", "-D", "FORWARD", "-j", forwardGuard)
		run(tool, "-w", "5", "-F", forwardGuard)
		run(tool, "-w", "5", "-X", forwardGuard)
	}
	return nil
}
func cleanOrphanRules() {
	for _, tool := range []string{"iptables", "ip6tables"} {
		out, e := exec.Command(tool + "-save").Output()
		if e != nil {
			continue
		}
		table := ""
		for _, line := range strings.Split(string(out), "\n") {
			if strings.HasPrefix(line, "*") {
				table = line[1:]
			}
			if !strings.HasPrefix(line, "-A ") || !strings.Contains(line, "wormhole-network-runtime:"+tunnelPrefix) {
				continue
			}
			fields := strings.Fields(line)
			name := ""
			for i, field := range fields {
				if field == "--comment" && i+1 < len(fields) {
					name = strings.TrimPrefix(strings.Trim(fields[i+1], "\""), "wormhole-network-runtime:")
				}
			}
			if !strings.HasPrefix(name, tunnelPrefix) || len(name) != len(tunnelPrefix)+8 {
				continue
			}
			if _, e = net.InterfaceByName(name); e == nil {
				continue
			}
			fields[0] = "-D"
			for i := range fields {
				fields[i] = strings.Trim(fields[i], "\"")
			}
			run(tool, append([]string{"-w", "5", "-t", table}, fields...)...)
		}
	}
}

type leaseOwner struct {
	PID   int
	Start string
}
type leaseState struct {
	Active  bool         `json:"active"`
	Holders []leaseOwner `json:"holders"`
	V4      string       `json:"v4"`
	V6      string       `json:"v6"`
}

func namespaceCookie() (string, error) {
	fd, e := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if e != nil {
		return "", e
	}
	defer unix.Close(fd)
	value, e := unix.GetsockoptUint64(fd, unix.SOL_SOCKET, unix.SO_NETNS_COOKIE)
	if e != nil {
		return "", fmt.Errorf("SO_NETNS_COOKIE unavailable; use proxy/relay mode or a kernel supporting full networking: %w", e)
	}
	return strconv.FormatUint(value, 10), nil
}
func processIdentity(file string) (leaseOwner, error) {
	data, e := os.ReadFile(file)
	if e != nil {
		return leaseOwner{}, e
	}
	text := string(data)
	end := strings.LastIndex(text, ")")
	if end < 0 {
		return leaseOwner{}, fmt.Errorf("invalid proc identity")
	}
	fields := strings.Fields(text[end+1:])
	if len(fields) < 20 || fields[0] == "Z" {
		return leaseOwner{}, fmt.Errorf("process exited")
	}
	pid, e := strconv.Atoi(strings.Fields(text)[0])
	return leaseOwner{pid, fields[19]}, e
}
func acquireForwarding() (func(), error) {
	if os.Geteuid() != 0 {
		return nil, fmt.Errorf("root required")
	}
	ns, e := os.Readlink("/proc/self/ns/net")
	if e != nil {
		return nil, e
	}
	cookie, e := namespaceCookie()
	if e != nil {
		return nil, e
	}
	self, e := processIdentity("/proc/self/stat")
	if e != nil {
		return nil, e
	}
	file := "/run/wormhole-forward-cookie-" + cookie + ".json"
	mutate := func(add bool) error {
		f, e := os.OpenFile(file, os.O_CREATE|os.O_RDWR, 0600)
		if e != nil {
			return e
		}
		defer f.Close()
		if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX); e != nil {
			return e
		}
		defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		var st leaseState
		json.NewDecoder(f).Decode(&st)
		stale := st.Active || len(st.Holders) > 0
		alive := []leaseOwner{}
		for _, owner := range st.Holders {
			current, err := processIdentity("/proc/" + strconv.Itoa(owner.PID) + "/stat")
			peerNS, _ := os.Readlink("/proc/" + strconv.Itoa(owner.PID) + "/ns/net")
			if err == nil && current == owner && peerNS == ns && (add || owner != self) {
				alive = append(alive, owner)
			}
		}
		st.Holders = alive
		if add {
			if len(alive) == 0 {
				if stale {
					if st.V4 != "" {
						os.WriteFile("/proc/sys/net/ipv4/ip_forward", []byte(st.V4), 0600)
					}
					if st.V6 != "" {
						os.WriteFile("/proc/sys/net/ipv6/conf/all/forwarding", []byte(st.V6), 0600)
					}
					if strings.TrimSpace(st.V4) == "0" {
						guard("iptables", false)
					}
					if strings.TrimSpace(st.V6) == "0" {
						guard("ip6tables", false)
					}
				}
				v4, _ := os.ReadFile("/proc/sys/net/ipv4/ip_forward")
				v6, _ := os.ReadFile("/proc/sys/net/ipv6/conf/all/forwarding")
				st.V4 = string(v4)
				st.V6 = string(v6)
				st.Active = true
				// Persist the original state before changing host forwarding.
				f.Truncate(0)
				f.Seek(0, 0)
				if e = json.NewEncoder(f).Encode(st); e != nil {
					return e
				}
			}
			if strings.TrimSpace(st.V4) == "0" {
				if e = guard("iptables", true); e != nil {
					return e
				}
			}
			if strings.TrimSpace(st.V6) == "0" {
				if e = guard("ip6tables", true); e != nil {
					if strings.TrimSpace(st.V4) == "0" {
						guard("iptables", false)
					}
					return e
				}
			}
			if e = os.WriteFile("/proc/sys/net/ipv4/ip_forward", []byte("1"), 0600); e != nil {
				return e
			}
			if e = os.WriteFile("/proc/sys/net/ipv6/conf/all/forwarding", []byte("1"), 0600); e != nil {
				return e
			}
			st.Holders = append(st.Holders, self)
		} else if len(alive) == 0 {
			st.Active = false
			if st.V4 != "" {
				os.WriteFile("/proc/sys/net/ipv4/ip_forward", []byte(st.V4), 0600)
			}
			if st.V6 != "" {
				os.WriteFile("/proc/sys/net/ipv6/conf/all/forwarding", []byte(st.V6), 0600)
			}
			if strings.TrimSpace(st.V4) == "0" {
				guard("iptables", false)
			}
			if strings.TrimSpace(st.V6) == "0" {
				guard("ip6tables", false)
			}
		}
		f.Truncate(0)
		f.Seek(0, 0)
		return json.NewEncoder(f).Encode(st)
	}
	cleanOrphanRules()
	if e = mutate(true); e != nil {
		mutate(false)
		return nil, e
	}
	return func() {
		if e := mutate(false); e != nil {
			fmt.Fprintln(os.Stderr, "network forwarding cleanup failed:", e)
		}
	}, nil
}
func configureTUN(name, client, peer, client6, peer6 string) (func(), error) {
	cookie, e := namespaceCookie()
	if e != nil {
		return func() {}, e
	}
	f, e := os.OpenFile("/run/wormhole-tun-pool-cookie-"+cookie, os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return func() {}, e
	}
	defer f.Close()
	if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX); e != nil {
		return func() {}, e
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	_, prefix, _ := net.ParseCIDR(client + "/30")
	routes, e := exec.Command("ip", "-4", "route", "show", "exact", prefix.String()).Output()
	if e != nil {
		return func() {}, e
	}
	if len(strings.TrimSpace(string(routes))) > 0 {
		return func() {}, errAddressInUse
	}

	type rule struct {
		cmd  string
		args []string
	}
	rules := []rule{}
	cleanup := func() {
		for i := len(rules) - 1; i >= 0; i-- {
			args := append([]string{}, rules[i].args...)
			for j, v := range args {
				if v == "-I" || v == "-A" {
					args[j] = "-D"
				}
			}
			run(rules[i].cmd, args...)
		}
	}
	for _, a := range [][]string{{"addr", "add", peer + "/30", "dev", name}, {"-6", "addr", "add", peer6 + "/126", "dev", name, "nodad"}, {"link", "set", name, "up"}} {
		if e := run("ip", a...); e != nil {
			return cleanup, e
		}
	}
	for _, item := range []struct{ tool, src string }{{"iptables", client + "/32"}, {"ip6tables", client6 + "/128"}} {
		for _, args := range [][]string{{"-w", "5", "-I", "FORWARD", "-i", name, "-m", "comment", "--comment", "wormhole-network-runtime:" + name, "-j", "ACCEPT"}, {"-w", "5", "-I", "FORWARD", "-o", name, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-m", "comment", "--comment", "wormhole-network-runtime:" + name, "-j", "ACCEPT"}, {"-w", "5", "-t", "nat", "-A", "POSTROUTING", "-s", item.src, "!", "-o", name, "-m", "comment", "--comment", "wormhole-network-runtime:" + name, "-j", "MASQUERADE"}} {
			if e := run(item.tool, args...); e != nil {
				cleanup()
				return func() {}, e
			}
			rules = append(rules, rule{item.tool, args})
		}
	}
	return cleanup, nil
}
