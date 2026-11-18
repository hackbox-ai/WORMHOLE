// WORMHOLE connector: authenticated packet service and an optional fixed-destination child relay.
// frp provides the encrypted, authenticated reverse transport. No remote shell is exposed.
package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.zx2c4.com/wireguard/tun"
)

var errAddressInUse = errors.New("tunnel prefix already in use")

type Config struct {
	Listen      string   `json:"listen"`
	Token       string   `json:"token"`
	Scopes      []string `json:"scopes"`
	FullNetwork bool     `json:"full_network"`
	RelayListen string   `json:"relay_listen"`
	Entry       string   `json:"entry"`
	Frpc        string   `json:"frpc"`
}
type Request struct {
	Token string `json:"token"`
	Op    string `json:"op"`
	Host  string `json:"host"`
}
type Server struct {
	c       Config
	mu      sync.Mutex
	dns     map[string]time.Time
	conns   map[net.Conn]bool
	slots   chan struct{}
	serial  atomic.Uint32
	closing bool
}

func (s *Server) track(c net.Conn) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		c.Close()
		return false
	}
	s.conns[c] = true
	return true
}
func (s *Server) forget(c net.Conn) { c.Close(); s.mu.Lock(); delete(s.conns, c); s.mu.Unlock() }
func (s *Server) close() {
	s.mu.Lock()
	s.closing = true
	for c := range s.conns {
		c.Close()
	}
	s.mu.Unlock()
}
func hostAllowed(scopes []string, host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	for _, scope := range scopes {
		scope = strings.ToLower(scope)
		if _, cidr, e := net.ParseCIDR(scope); e == nil {
			if ip := net.ParseIP(host); ip != nil && cidr.Contains(ip) {
				return true
			}
		} else if scope == host || strings.HasPrefix(scope, "*.") && strings.HasSuffix(host, scope[1:]) && host != scope[2:] {
			return true
		}
	}
	return false
}
func (s *Server) allowed(ip net.IP) bool {
	if hostAllowed(s.c.Scopes, ip.String()) {
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return time.Now().Before(s.dns[ip.String()])
}
func readLine(r *bufio.Reader) ([]byte, error) {
	p, e := r.ReadSlice('\n')
	if len(p) > 8192 {
		return nil, errors.New("request too large")
	}
	return p, e
}
func reply(w io.Writer, v any) error { return json.NewEncoder(w).Encode(v) }
func readPacket(r io.Reader) ([]byte, error) {
	var n [4]byte
	if _, e := io.ReadFull(r, n[:]); e != nil {
		return nil, e
	}
	size := binary.BigEndian.Uint32(n[:])
	if size < 20 || size > 65535 {
		return nil, errors.New("invalid packet size")
	}
	p := make([]byte, size)
	_, e := io.ReadFull(r, p)
	return p, e
}
func writePacket(w io.Writer, p []byte) error {
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], uint32(len(p)))
	if _, e := w.Write(n[:]); e != nil {
		return e
	}
	_, e := w.Write(p)
	return e
}
func packetIPs(p []byte) (net.IP, net.IP) {
	if len(p) >= 20 && p[0]>>4 == 4 && int(binary.BigEndian.Uint16(p[2:4])) == len(p) {
		return net.IP(p[12:16]), net.IP(p[16:20])
	}
	if len(p) >= 40 && p[0]>>4 == 6 && int(binary.BigEndian.Uint16(p[4:6]))+40 == len(p) {
		return net.IP(p[8:24]), net.IP(p[24:40])
	}
	return nil, nil
}
func (s *Server) handle(c net.Conn) {
	if !s.track(c) {
		return
	}
	defer s.forget(c)
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		return
	}
	c.SetReadDeadline(time.Now().Add(10 * time.Second))
	r := bufio.NewReaderSize(c, 8193)
	line, e := readLine(r)
	if e != nil {
		return
	}
	var req Request
	if json.Unmarshal(line, &req) != nil || len(req.Token) != len(s.c.Token) || subtle.ConstantTimeCompare([]byte(req.Token), []byte(s.c.Token)) != 1 {
		return
	}
	c.SetReadDeadline(time.Time{})
	switch req.Op {
	case "status":
		reply(c, map[string]any{"ok": true, "full_network": s.c.FullNetwork, "ipv6": runtime.GOOS != "windows"})
	case "resolve":
		if !hostAllowed(s.c.Scopes, req.Host) {
			reply(c, map[string]any{"ok": false, "error": "domain outside channel scope"})
			return
		}
		ips, e := net.LookupIP(req.Host)
		if e != nil {
			reply(c, map[string]any{"ok": false, "error": "remote DNS failed"})
			return
		}
		result := []string{}
		s.mu.Lock()
		for ip, expiry := range s.dns {
			if time.Now().After(expiry) {
				delete(s.dns, ip)
			}
		}
		for _, ip := range ips {
			if len(result) < 32 {
				result = append(result, ip.String())
				if len(s.dns) >= 4096 {
					for key := range s.dns {
						delete(s.dns, key)
						break
					}
				}
				s.dns[ip.String()] = time.Now().Add(60 * time.Second)
			}
		}
		s.mu.Unlock()
		reply(c, map[string]any{"ok": true, "addresses": result})
	case "packets":
		if !s.c.FullNetwork {
			reply(c, map[string]any{"ok": false, "error": "full network disabled"})
			return
		}
		s.packetSession(c, r)
	default:
		reply(c, map[string]any{"ok": false, "error": "unsupported operation"})
	}
}

// Kernel interfaces have a 15-byte name limit; use the WORMHOLE abbreviation.
const tunnelPrefix = "gty"

func tunnelName(pid int, serial uint32) string {
	return fmt.Sprintf("%s%04x%04x", tunnelPrefix, pid&0xffff, serial&0xffff)
}
func (s *Server) packetSession(c net.Conn, r io.Reader) {
	name := tunnelName(os.Getpid(), s.serial.Add(1))
	dev, e := tun.CreateTUN(name, 1400)
	if e != nil {
		reply(c, map[string]any{"ok": false, "error": "TUN unavailable; run connector with administrator privileges"})
		return
	}
	defer dev.Close()
	name, _ = dev.Name()
	var client, peer, client6, peer6 string
	var cleanup func()
	for attempt := 0; attempt < 16; attempt++ {
		var seed [2]byte
		rand.Read(seed[:])
		index := int(binary.BigEndian.Uint16(seed[:]))%32766 + 1
		value := index * 4
		client = fmt.Sprintf("198.%d.%d.%d", 18+(value>>16), value>>8&255, value&255+1)
		peer = fmt.Sprintf("198.%d.%d.%d", 18+(value>>16), value>>8&255, value&255+2)
		client6 = fmt.Sprintf("fd7b:5642:%x::1", index)
		peer6 = fmt.Sprintf("fd7b:5642:%x::2", index)
		if runtime.GOOS == "windows" {
			client6 = ""
			peer6 = ""
		}
		cleanup, e = configureTUN(name, client, peer, client6, peer6)
		if !errors.Is(e, errAddressInUse) {
			break
		}
	}
	if e != nil {
		reply(c, map[string]any{"ok": false, "error": "TUN routing/NAT setup failed"})
		return
	}
	defer cleanup()
	if reply(c, map[string]any{"ok": true, "client": client + "/30", "peer": peer, "client6": client6 + "/126", "peer6": peer6}) != nil {
		return
	}
	var pinsMu sync.Mutex
	pins := map[string]bool{}
	allowed := func(ip net.IP) bool {
		if hostAllowed(s.c.Scopes, ip.String()) {
			return true
		}
		pinsMu.Lock()
		defer pinsMu.Unlock()
		if pins[ip.String()] {
			return true
		}
		if len(pins) < 4096 && s.allowed(ip) {
			pins[ip.String()] = true
			return true
		}
		return false
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer c.Close()
		buffers := make([][]byte, dev.BatchSize())
		sizes := make([]int, len(buffers))
		for i := range buffers {
			buffers[i] = make([]byte, 65535+16)
		}
		for {
			n, e := dev.Read(buffers, sizes, 16)
			if e != nil {
				return
			}
			for i := 0; i < n; i++ {
				p := buffers[i][16 : 16+sizes[i]]
				src, dst := packetIPs(p)
				if dst == nil || !(dst.Equal(net.ParseIP(client)) || dst.Equal(net.ParseIP(client6))) || !allowed(src) {
					continue
				}
				if writePacket(c, p) != nil {
					return
				}
			}
		}
	}()
	for {
		p, e := readPacket(r)
		if e != nil {
			break
		}
		src, dst := packetIPs(p)
		if src == nil || !(src.Equal(net.ParseIP(client)) || src.Equal(net.ParseIP(client6))) || !allowed(dst) {
			continue
		}
		wire := make([]byte, len(p)+16)
		copy(wire[16:], p)
		if _, e = dev.Write([][]byte{wire}, 16); e != nil {
			break
		}
	}
	c.Close()
	dev.Close()
	<-done
}
func (s *Server) relay(c net.Conn) {
	if !s.track(c) {
		return
	}
	defer s.forget(c)
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		return
	}
	// Accept CONNECT only, never relay WORMHOLE's web/API routes.
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	reader := bufio.NewReaderSize(c, 8192)
	var header []byte
	for {
		part, err := reader.ReadSlice(10)
		if err != nil || len(header)+len(part) > 8192 {
			return
		}
		header = append(header, part...)
		if bytes.Equal(part, []byte("\r\n")) {
			break
		}
	}
	request, err := http.ReadRequest(bufio.NewReader(bytes.NewReader(header)))
	if err != nil || request.Method != "CONNECT" || request.ContentLength > 0 || len(request.TransferEncoding) > 0 || !strings.HasPrefix(request.Host, "127.0.0.1:") || !strings.HasPrefix(request.Header.Get("Proxy-Authorization"), "Basic ") {
		return
	}
	c.SetReadDeadline(time.Time{})
	// The relay has exactly one destination; WORMHOLE validates the child's credential.
	up, e := net.DialTimeout("tcp", s.c.Entry, 10*time.Second)
	if e != nil {
		return
	}
	if !s.track(up) {
		return
	}
	defer s.forget(up)
	if request.Write(up) != nil {
		return
	}
	done := make(chan struct{})
	go func() { io.Copy(up, reader); up.Close(); close(done) }()
	io.Copy(c, up)
	c.Close()
	<-done
}

// Resolve relative executables against the bundle, never the caller PATH.
func connectorExecutable(configPath, executable string) (string, string, error) {
	absolute, err := filepath.Abs(configPath)
	if err != nil {
		return "", "", err
	}
	if executable == "" {
		executable = "frpc"
		if runtime.GOOS == "windows" {
			executable += ".exe"
		}
	}
	if !filepath.IsAbs(executable) {
		executable = filepath.Join(filepath.Dir(absolute), executable)
	}
	return absolute, executable, nil
}

func runConnector(config string, stop <-chan os.Signal) error {
	data, e := os.ReadFile(config)
	if e != nil {
		return errors.New("connector configuration unavailable")
	}
	var cfg Config
	if json.Unmarshal(data, &cfg) != nil || len(cfg.Token) != 64 {
		return errors.New("invalid connector configuration")
	}
	configPath, executable, err := connectorExecutable(config, cfg.Frpc)
	if err != nil {
		return errors.New("connector path unavailable")
	}
	cfg.Frpc = executable
	s := &Server{c: cfg, dns: map[string]time.Time{}, conns: map[net.Conn]bool{}, slots: make(chan struct{}, 128)}
	var lis, relay net.Listener
	var release func()
	defer func() {
		if lis != nil {
			lis.Close()
		}
		if relay != nil {
			relay.Close()
		}
		s.close()
		deadline := time.Now().Add(4 * time.Second)
		for len(s.slots) > 0 && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
		if release != nil {
			release()
		}
	}()
	lis, e = net.Listen("tcp", cfg.Listen)
	if e != nil {
		return errors.New("connector local port unavailable")
	}
	if cfg.RelayListen != "" {
		relay, e = net.Listen("tcp", cfg.RelayListen)
		if e != nil {
			return errors.New("child relay port unavailable")
		}
		go func() {
			for {
				c, e := relay.Accept()
				if e != nil {
					return
				}
				go s.relay(c)
			}
		}()
	}
	go func() {
		for {
			c, e := lis.Accept()
			if e != nil {
				return
			}
			go s.handle(c)
		}
	}()
	if cfg.FullNetwork {
		release, e = acquireForwarding()
		if e != nil {
			return fmt.Errorf("full network initialization failed: %w", e)
		}
	}
	child := exec.Command(cfg.Frpc, "-c", filepath.Join(filepath.Dir(configPath), "frpc.toml"))
	child.Dir = filepath.Dir(configPath)
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	if err := child.Start(); err != nil {
		return fmt.Errorf("cannot start bundled frpc: %w", err)
	}
	done := make(chan error, 1)
	go func() { done <- child.Wait() }()
	select {
	case <-stop:
		child.Process.Kill()
		select {
		case <-done:
			return nil
		case <-time.After(5 * time.Second):
			return errors.New("frpc did not exit after stop")
		}
	case err := <-done:
		if err != nil {
			return fmt.Errorf("frpc exited unexpectedly: %w", err)
		}
		return errors.New("frpc exited unexpectedly")
	}
}
func main() {
	config := flag.String("config", "connector.json", "connector config")
	flag.Parse()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(stop)
	if err := runConnector(*config, stop); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
