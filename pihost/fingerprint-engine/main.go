// Offline fingerprint helper. No transport or target request is implemented here.
package main

import (
	"bufio"
	"bytes"
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/chainreactors/fingers/common"
	native "github.com/chainreactors/fingers/fingers"
	"github.com/chainreactors/fingers/goby"
	"github.com/chainreactors/fingers/wappalyzer"
	"github.com/spaolacci/murmur3"
	"golang.org/x/net/html"
)

type rule struct {
	ID     string          `json:"id"`
	Family string          `json:"family"`
	Name   string          `json:"name"`
	Raw    json.RawMessage `json:"raw"`
}
type diagnostic struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
}
type observation struct {
	RuleID    string   `json:"rule_id"`
	Family    string   `json:"family"`
	Product   string   `json:"product"`
	Version   string   `json:"version,omitempty"`
	Locations []string `json:"locations"`
	Evidence  string   `json:"evidence"`
	State     string   `json:"state"`
}
type material struct {
	URL         string `json:"url"`
	Method      string `json:"method"`
	Response    string `json:"response_base64"`
	Favicon     string `json:"favicon_base64,omitempty"`
	FaviconMD5  string `json:"favicon_md5,omitempty"`
	FaviconMMH3 string `json:"favicon_mmh3,omitempty"`
}
type request struct {
	ID       string   `json:"id"`
	Action   string   `json:"action"`
	Snapshot string   `json:"snapshot"`
	Rules    []rule   `json:"rules"`
	Material material `json:"material"`
}
type result struct {
	ID          string        `json:"id"`
	Error       string        `json:"error,omitempty"`
	Snapshot    string        `json:"snapshot"`
	Diagnostics []diagnostic  `json:"diagnostics,omitempty"`
	Matches     []observation `json:"matches,omitempty"`
	Missing     []string      `json:"missing,omitempty"`
}
type web interface {
	WebMatch([]byte) common.Frameworks
}
type compiled struct {
	Rule       rule
	Diagnostic diagnostic
	Match      func(*input) (bool, string, []string)
	NeedsIcon  bool
}
type input struct {
	raw                                    []byte
	body, header, title, iconMD5, iconMMH3 string
	url                                    *url.URL
	method                                 string
	status                                 int
	icon                                   []byte
}

var arlCondition = regexp.MustCompile(`(body|header|title|icon_hash)="((?:[^"\\]|\\.)*)"`)
var htmlTitle = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title\s*>`)

func all(values []string, text string, fold bool) bool {
	if fold {
		text = strings.ToLower(text)
	}
	for _, v := range values {
		if fold {
			v = strings.ToLower(v)
		}
		if !strings.Contains(text, v) {
			return false
		}
	}
	return len(values) > 0
}
func title(body string) string {
	z := html.NewTokenizer(strings.NewReader(body))
	inside := false
	for {
		switch z.Next() {
		case html.ErrorToken:
			return ""
		case html.StartTagToken:
			if z.Token().Data == "title" {
				inside = true
			}
		case html.TextToken:
			if inside {
				return z.Token().Data
			}
		case html.EndTagToken:
			if inside {
				return ""
			}
		}
	}
}
func pythonBase64(b []byte) []byte {
	s := base64.StdEncoding.EncodeToString(b)
	var out strings.Builder
	for len(s) > 76 {
		out.WriteString(s[:76])
		out.WriteByte('\n')
		s = s[76:]
	}
	if len(s) > 0 {
		out.WriteString(s)
		out.WriteByte('\n')
	}
	return []byte(out.String())
}
func parseMaterial(m material) (*input, error) {
	raw, e := base64.StdEncoding.DecodeString(m.Response)
	if e != nil || len(raw) > 5*1024*1024 {
		return nil, fmt.Errorf("invalid response material")
	}
	resp, e := http.ReadResponse(bufio.NewReader(bytes.NewReader(raw)), nil)
	if e != nil {
		return nil, e
	}
	defer resp.Body.Close()
	body, e := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024+1))
	if e != nil || len(body) > 4*1024*1024 {
		return nil, fmt.Errorf("body exceeds budget")
	}
	u, e := url.Parse(m.URL)
	if e != nil || u.Host == "" || u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("invalid URL")
	}
	var h strings.Builder
	for key, values := range resp.Header {
		for _, v := range values {
			fmt.Fprintf(&h, "%s: %s\n", key, v)
		}
	}
	in := &input{raw: raw, body: string(body), header: h.String(), title: title(string(body)), url: u, method: strings.ToUpper(m.Method), status: resp.StatusCode, iconMD5: m.FaviconMD5, iconMMH3: m.FaviconMMH3}
	if m.Favicon != "" {
		in.icon, e = base64.StdEncoding.DecodeString(m.Favicon)
		if e != nil || len(in.icon) > 1024*1024 {
			return nil, fmt.Errorf("invalid favicon")
		}
		sum := md5.Sum(in.icon)
		in.iconMD5 = hex.EncodeToString(sum[:])
		in.iconMMH3 = strconv.FormatInt(int64(int32(murmur3.Sum32(pythonBase64(in.icon)))), 10)
	}
	return in, nil
}
func compile(r rule) (c compiled) {
	c.Rule = r
	c.Diagnostic = diagnostic{ID: r.ID, Status: "ready"}
	defer func() {
		if p := recover(); p != nil {
			c.Diagnostic.Status = "unsupported"
			c.Diagnostic.Reason = fmt.Sprint(p)
			c.Match = nil
		}
	}()
	fail := func(e error) compiled { c.Diagnostic.Status = "unsupported"; c.Diagnostic.Reason = e.Error(); return c }
	switch r.Family {
	case "ehole":
		var fp struct {
			CMS, Method, Location string
			Keyword               []string
		}
		if e := json.Unmarshal(r.Raw, &fp); e != nil {
			return fail(e)
		}
		if len(fp.Keyword) == 0 {
			return fail(fmt.Errorf("empty EHole predicates"))
		}
		if fp.Location != "body" && fp.Location != "header" && fp.Location != "title" {
			return fail(fmt.Errorf("unsupported EHole location"))
		}
		regexes := []*regexp.Regexp{}
		if fp.Method == "regular" {
			for _, pattern := range fp.Keyword {
				re, e := regexp.Compile("(?i)" + pattern)
				if e != nil {
					return fail(e)
				}
				regexes = append(regexes, re)
			}
		} else if fp.Method != "keyword" && fp.Method != "faviconhash" {
			return fail(fmt.Errorf("unsupported EHole method"))
		}
		c.NeedsIcon = fp.Method == "faviconhash"
		c.Match = func(in *input) (bool, string, []string) {
			text := in.body
			if fp.Location == "title" {
				text = in.title
			} else if fp.Location == "header" {
				text = in.header
			}
			if c.NeedsIcon {
				for _, v := range fp.Keyword {
					if v == in.iconMMH3 || v == in.iconMD5 {
						return true, "", []string{"favicon"}
					}
				}
				return false, "", nil
			}
			if fp.Method == "regular" {
				for _, re := range regexes {
					if !re.MatchString(text) {
						return false, "", nil
					}
				}
				return true, "", []string{fp.Location}
			}
			return all(fp.Keyword, text, true), "", []string{fp.Location}
		}
	case "goby", "wappalyzer", "fingers":
		var engine web
		var e error
		var raw map[string]any
		json.Unmarshal(r.Raw, &raw)
		if r.Family == "goby" {
			engine, e = goby.NewGobyEngine(append(append([]byte{'['}, r.Raw...), ']'))
		}
		if r.Family == "wappalyzer" {
			encoded, _ := json.Marshal(map[string]any{"apps": map[string]any{r.Name: raw}})
			engine, e = wappalyzer.NewWappalyzeEngine(encoded)
			if nonempty(raw["js"]) || nonempty(raw["css"]) || nonempty(raw["scripts"]) {
				c.Diagnostic.Status = "partial"
				c.Diagnostic.Reason = "JS/CSS runtime and inline scripts are not evaluated; HTTP predicates remain available"
			}
		}
		if r.Family == "fingers" {
			rules, _ := raw["rule"].([]any)
			passive := []any{}
			removed := false
			for _, v := range rules {
				p, ok := v.(map[string]any)
				if !ok {
					return fail(fmt.Errorf("invalid Fingers predicate"))
				}
				if nonempty(p["send_data"]) {
					removed = true
					continue
				}
				passive = append(passive, p)
			}
			if len(passive) == 0 {
				return fail(fmt.Errorf("requires active request material"))
			}
			raw["rule"] = passive
			encoded, _ := json.Marshal([]any{raw})
			var nativeEngine *native.FingersEngine
			nativeEngine, e = native.NewFingersEngine(encoded, []byte("[]"), nil)
			engine = nativeEngine
			if e == nil && len(nativeEngine.Favicons.Md5Fingers)+len(nativeEngine.Favicons.Mmh3Fingers) > 0 {
				c.NeedsIcon = true
			}
			if removed {
				c.Diagnostic.Status = "partial"
				c.Diagnostic.Reason = "active send_data predicates are not evaluated"
			}
			if e == nil {
				c.Match = func(in *input) (bool, string, []string) {
					frames := nativeEngine.WebMatch(in.raw)
					for _, frame := range frames {
						return true, frame.Version, []string{"response"}
					}
					if in.iconMD5 != "" || in.iconMMH3 != "" {
						if nativeEngine.Favicons.HashMatch(in.iconMD5, in.iconMMH3) != nil {
							return true, "", []string{"favicon"}
						}
					}
					return false, "", nil
				}
			}
		}
		if e != nil {
			return fail(e)
		}
		if c.Match == nil {
			c.Match = func(in *input) (bool, string, []string) {
				for _, frame := range engine.WebMatch(in.raw) {
					return true, frame.Version, []string{"response"}
				}
				return false, "", nil
			}
		}
	case "arl":
		var fp struct{ Name, Rule string }
		if e := json.Unmarshal(r.Raw, &fp); e != nil {
			return fail(e)
		}
		predicates := arlCondition.FindAllStringSubmatch(fp.Rule, -1)
		rest := arlCondition.ReplaceAllString(fp.Rule, "")
		if len(predicates) == 0 || strings.TrimSpace(strings.ReplaceAll(rest, "&&", "")) != "" {
			return fail(fmt.Errorf("unsupported ARL expression"))
		}
		for i, p := range predicates {
			var value string
			if e := json.Unmarshal([]byte(`"`+p[2]+`"`), &value); e != nil {
				return fail(e)
			}
			predicates[i][2] = value
			if p[1] == "icon_hash" {
				c.NeedsIcon = true
			}
		}
		c.Match = func(in *input) (bool, string, []string) {
			locations := []string{}
			for _, p := range predicates {
				v := in.body
				switch p[1] {
				case "header":
					v = in.header
				case "title":
					v = in.title
				case "icon_hash":
					if in.iconMMH3 != p[2] && in.iconMD5 != p[2] {
						return false, "", nil
					}
					locations = append(locations, "favicon")
					continue
				}
				if !all([]string{p[2]}, v, true) {
					return false, "", nil
				}
				locations = append(locations, p[1])
			}
			return true, "", locations
		}
	case "fingerprinthub":
		var fp hubRule
		if e := json.Unmarshal(r.Raw, &fp); e != nil {
			return fail(e)
		}
		if len(fp.HTTP) == 0 {
			return fail(fmt.Errorf("no HTTP predicates"))
		}
		for i := range fp.HTTP {
			q := &fp.HTTP[i]
			if len(q.Headers) > 0 || q.CookieReuse {
				return fail(fmt.Errorf("request headers/cookie state require request-context association"))
			}
			if len(q.Extractors) > 0 {
				c.Diagnostic.Status = "partial"
				c.Diagnostic.Reason = "product predicates available; version extractors are not evaluated"
			}
			if q.Method != "" && strings.ToUpper(q.Method) != "GET" && strings.ToUpper(q.Method) != "HEAD" {
				return fail(fmt.Errorf("non-GET/HEAD template requires request-body association"))
			}
			if len(q.Path) == 0 || len(q.Matchers) == 0 {
				return fail(fmt.Errorf("missing request path or matchers"))
			}
			if q.MatchersCondition != "" && q.MatchersCondition != "and" && q.MatchersCondition != "or" {
				return fail(fmt.Errorf("unsupported matcher condition"))
			}
			for j := range q.Matchers {
				m := &q.Matchers[j]
				if m.Encoding != "" {
					return fail(fmt.Errorf("encoded matcher requires adapter"))
				}
				if m.Condition != "" && m.Condition != "and" && m.Condition != "or" {
					return fail(fmt.Errorf("unsupported matcher condition"))
				}
				switch m.Type {
				case "word":
					if len(m.Words) == 0 {
						return fail(fmt.Errorf("empty words"))
					}
				case "regex":
					if len(m.Regex) == 0 {
						return fail(fmt.Errorf("empty regex"))
					}
					for _, pattern := range m.Regex {
						if m.CaseInsensitive {
							pattern = "(?i)" + pattern
						}
						re, e := regexp.Compile(pattern)
						if e != nil {
							return fail(e)
						}
						m.compiled = append(m.compiled, re)
					}
				case "favicon":
					c.NeedsIcon = true
					if len(m.Hash) == 0 {
						return fail(fmt.Errorf("empty favicon hashes"))
					}
				default:
					return fail(fmt.Errorf("unsupported matcher: %s", m.Type))
				}
				if m.Part != "" && m.Part != "body" && m.Part != "header" && m.Part != "all_headers" && m.Part != "all" && m.Part != "raw" && m.Part != "title" {
					return fail(fmt.Errorf("unsupported matcher part: %s", m.Part))
				}
			}
		}
		c.Match = func(in *input) (bool, string, []string) {
			for _, q := range fp.HTTP {
				if !q.applies(in) {
					continue
				}
				values := []bool{}
				locations := []string{}
				for _, m := range q.Matchers {
					matched, location := m.matches(in)
					values = append(values, matched)
					if matched {
						locations = append(locations, location)
					}
				}
				if combine(values, q.MatchersCondition == "and") {
					return true, "", locations
				}
			}
			return false, "", nil
		}
	default:
		return fail(fmt.Errorf("unsupported family"))
	}
	return c
}
func nonempty(v any) bool {
	if v == nil {
		return false
	}
	switch x := v.(type) {
	case []any:
		return len(x) > 0
	case map[string]any:
		return len(x) > 0
	case string:
		return x != ""
	}
	return true
}

type hubRule struct {
	HTTP []hubRequest `json:"http"`
}
type hubRequest struct {
	Method            string            `json:"method"`
	Path              []string          `json:"path"`
	MatchersCondition string            `json:"matchers-condition"`
	Matchers          []hubMatcher      `json:"matchers"`
	Extractors        []json.RawMessage `json:"extractors"`
	Headers           map[string]string `json:"headers"`
	CookieReuse       bool              `json:"cookie-reuse"`
}
type hubMatcher struct {
	Type            string   `json:"type"`
	Words           []string `json:"words"`
	Regex           []string `json:"regex"`
	Hash            []string `json:"hash"`
	Part            string   `json:"part"`
	Condition       string   `json:"condition"`
	Negative        bool     `json:"negative"`
	CaseInsensitive bool     `json:"case-insensitive"`
	Encoding        string   `json:"encoding"`
	compiled        []*regexp.Regexp
}

func (q hubRequest) applies(in *input) bool {
	method := strings.ToUpper(q.Method)
	if method == "" {
		method = "GET"
	}
	if method != in.method {
		return false
	}
	for _, p := range q.Path {
		if p == "{{BaseURL}}" || p == "{{BaseURL}}/" || p == "{{RootURL}}" || p == "{{RootURL}}/" {
			if in.url.Path == "" || in.url.Path == "/" {
				return true
			}
			continue
		}
		p = strings.ReplaceAll(strings.ReplaceAll(p, "{{BaseURL}}", ""), "{{RootURL}}", "")
		if !strings.Contains(p, "{{") && p == in.url.RequestURI() {
			return true
		}
	}
	return false
}
func combine(v []bool, and bool) bool {
	if len(v) == 0 {
		return false
	}
	if and {
		for _, b := range v {
			if !b {
				return false
			}
		}
		return true
	}
	for _, b := range v {
		if b {
			return true
		}
	}
	return false
}
func (m hubMatcher) matches(in *input) (bool, string) {
	part := m.Part
	if part == "" {
		part = "body"
	}
	text := in.body
	switch part {
	case "header", "all_headers":
		text = in.header
	case "all", "raw":
		text = string(in.raw)
	case "title":
		text = in.title
	}
	if m.Type == "favicon" {
		if in.iconMD5 == "" && in.iconMMH3 == "" {
			return false, "favicon"
		}
		values := []bool{}
		for _, h := range m.Hash {
			values = append(values, h == in.iconMD5 || h == in.iconMMH3)
		}
		return combine(values, m.Condition == "and") != m.Negative, "favicon"
	}
	values := []bool{}
	if m.Type == "word" {
		for _, word := range m.Words {
			values = append(values, all([]string{word}, text, m.CaseInsensitive))
		}
	} else {
		for _, re := range m.compiled {
			values = append(values, re.MatchString(text))
		}
	}
	return combine(values, m.Condition == "and") != m.Negative, part
}

type helper struct {
	snapshots map[string][]compiled
	order     []string
}

func (h *helper) execute(req request) (out result) {
	out.ID = req.ID
	out.Snapshot = req.Snapshot
	defer func() {
		if p := recover(); p != nil {
			out.Error = fmt.Sprint(p)
		}
	}()
	if req.Action == "load" {
		if req.Snapshot == "" || len(req.Rules) > 50000 {
			out.Error = "invalid rule snapshot"
			return
		}
		items := []compiled{}
		for _, r := range req.Rules {
			c := compile(r)
			items = append(items, c)
			out.Diagnostics = append(out.Diagnostics, c.Diagnostic)
		}
		if _, ok := h.snapshots[req.Snapshot]; !ok {
			h.order = append(h.order, req.Snapshot)
		}
		h.snapshots[req.Snapshot] = items
		for len(h.order) > 3 {
			delete(h.snapshots, h.order[0])
			h.order = h.order[1:]
		}
		return
	}
	if req.Action != "match" {
		out.Error = "invalid action"
		return
	}
	items, ok := h.snapshots[req.Snapshot]
	if !ok {
		out.Error = "snapshot not loaded"
		return
	}
	in, e := parseMaterial(req.Material)
	if e != nil {
		out.Error = e.Error()
		return
	}
	for _, c := range items {
		if c.Match == nil {
			continue
		}
		hit, version, locations := c.Match(in)
		if hit {
			evidence := "Matched rule against supplied response"
			if len(locations) == 1 && locations[0] == "favicon" {
				evidence = "Matched supplied favicon hash"
			}
			out.Matches = append(out.Matches, observation{RuleID: c.Rule.ID, Family: c.Rule.Family, Product: c.Rule.Name, Version: version, Locations: locations, Evidence: evidence, State: "direct"})
		} else if c.NeedsIcon && in.iconMD5 == "" && in.iconMMH3 == "" {
			out.Missing = append(out.Missing, c.Rule.ID)
		}
	}
	return
}
func main() {
	// Third-party initialization logs must never contaminate the JSONL protocol.
	protocol := os.Stdout
	os.Stdout = os.Stderr
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 65536), 32*1024*1024)
	encoder := json.NewEncoder(protocol)
	h := helper{snapshots: map[string][]compiled{}}
	for scanner.Scan() {
		var req request
		if e := json.Unmarshal(scanner.Bytes(), &req); e != nil {
			encoder.Encode(result{Error: "invalid JSON"})
			continue
		}
		encoder.Encode(h.execute(req))
	}
	if e := scanner.Err(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
