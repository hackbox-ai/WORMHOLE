package main

import (
	"encoding/base64"
	"encoding/json"
	"testing"
)

func testRule(family, raw string) rule {
	return rule{ID: "fixture-" + family, Family: family, Name: "wormhole-product", Raw: json.RawMessage(raw)}
}
func testInput(body, path string) *input {
	in, e := parseMaterial(material{URL: "https://sample.invalid" + path, Method: "GET", Response: base64.StdEncoding.EncodeToString([]byte("HTTP/1.1 200 OK\r\nX-WORMHOLE: proof\r\n\r\n" + body))})
	if e != nil {
		panic(e)
	}
	return in
}
func TestSixFamilies(t *testing.T) {
	fixtures := map[string]string{
		"ehole":          `{"cms":"wormhole-product","method":"keyword","location":"body","keyword":["vbmarker","second"]}`,
		"goby":           `{"name":"wormhole-product","logic":"a&&b","rule":[{"label":"a","feature":"vbmarker","is_equal":true},{"label":"b","feature":"forbidden","is_equal":false}]}`,
		"wappalyzer":     `{"html":["vbmarker"]}`,
		"fingers":        `{"name":"wormhole-product","rule":[{"regexps":{"body":["vbmarker"]}}]}`,
		"fingerprinthub": `{"id":"wormhole-product","info":{"name":"wormhole-product"},"http":[{"method":"GET","path":["{{BaseURL}}/"],"matchers":[{"type":"word","words":["vbmarker"]}]}]}`,
		"arl":            `{"name":"wormhole-product","rule":"body=\"vbmarker\" && header=\"X-WORMHOLE\""}`,
	}
	for family, raw := range fixtures {
		t.Run(family, func(t *testing.T) {
			c := compile(testRule(family, raw))
			if c.Match == nil {
				t.Fatal(c.Diagnostic)
			}
			yes, _, _ := c.Match(testInput("vbmarker second", "/"))
			no, _, _ := c.Match(testInput("plain forbidden", "/"))
			if !yes || no {
				t.Fatalf("positive=%v negative=%v", yes, no)
			}
		})
	}
}
func TestTitleLocation(t *testing.T) {
	c := compile(testRule("ehole", `{"cms":"wormhole","method":"keyword","location":"title","keyword":["vbmarker"]}`))
	yes, _, _ := c.Match(testInput("<title>vbmarker</title>", "/"))
	no, _, _ := c.Match(testInput("<title>plain</title><p>vbmarker</p>", "/"))
	if !yes || no {
		t.Fatal("title scope was lost")
	}
}
func TestHubPathAndMethod(t *testing.T) {
	c := compile(testRule("fingerprinthub", `{"http":[{"method":"GET","path":["{{BaseURL}}/admin"],"matchers":[{"type":"word","words":["vbmarker"]}]}]}`))
	root, _, _ := c.Match(testInput("vbmarker", "/"))
	admin, _, _ := c.Match(testInput("vbmarker", "/admin"))
	if root || !admin {
		t.Fatal("request path not enforced")
	}
	wrong := testInput("vbmarker", "/admin")
	wrong.method = "POST"
	hit, _, _ := c.Match(wrong)
	if hit {
		t.Fatal("method not enforced")
	}
}
func TestHubFavicon(t *testing.T) {
	c := compile(testRule("fingerprinthub", `{"http":[{"path":["{{BaseURL}}/"],"matchers":[{"type":"favicon","hash":["abc"]}]}]}`))
	if c.Diagnostic.Status != "ready" {
		t.Fatal(c.Diagnostic)
	}
	in := testInput("plain", "/")
	hit, _, _ := c.Match(in)
	if hit {
		t.Fatal("missing favicon should not match")
	}
	in.iconMD5 = "abc"
	hit, _, _ = c.Match(in)
	if !hit {
		t.Fatal("favicon not matched")
	}
}
func TestUnsupportedIsVisible(t *testing.T) {
	c := compile(testRule("fingerprinthub", `{"http":[{"path":["{{BaseURL}}/"],"matchers":[{"type":"regex","regex":["(?x)nginx"]}]}]}`))
	if c.Diagnostic.Status != "unsupported" || c.Diagnostic.Reason == "" {
		t.Fatal(c.Diagnostic)
	}
}
func TestPartialWappalyzer(t *testing.T) {
	c := compile(testRule("wappalyzer", `{"js":["window.marker"],"html":["vbmarker"]}`))
	if c.Diagnostic.Status != "partial" {
		t.Fatal(c.Diagnostic)
	}
	hit, _, _ := c.Match(testInput("vbmarker", "/"))
	if !hit {
		t.Fatal("supported predicate lost")
	}
}
func TestARLRejectsIgnoredOperators(t *testing.T) {
	c := compile(testRule("arl", `{"name":"wormhole","rule":"body=\"one\" || body=\"two\""}`))
	if c.Diagnostic.Status != "unsupported" {
		t.Fatal("unsupported OR must not become AND")
	}
}
func TestEvidenceIdentity(t *testing.T) {
	h := helper{snapshots: map[string][]compiled{}}
	r := testRule("ehole", `{"cms":"wormhole-product","method":"keyword","location":"body","keyword":["vbmarker"]}`)
	h.execute(request{Action: "load", Snapshot: "s", Rules: []rule{r}})
	out := h.execute(request{ID: "request-7", Action: "match", Snapshot: "s", Material: material{URL: "https://sample.invalid/", Method: "GET", Response: base64.StdEncoding.EncodeToString([]byte("HTTP/1.1 200 OK\r\n\r\nvbmarker"))}})
	if out.ID != "request-7" || len(out.Matches) != 1 || out.Matches[0].RuleID != r.ID {
		t.Fatal(out)
	}
}

func TestHubRequestContextAndExtractors(t *testing.T) {
	for _, extra := range []string{`"headers":{"Cookie":"rememberMe=1"}`, `"cookie-reuse":true`, `"method":"POST"`} {
		c := compile(testRule("fingerprinthub", `{"http":[{`+extra+`,"path":["{{BaseURL}}/"],"matchers":[{"type":"word","words":["vbmarker"]}]}]}`))
		if c.Diagnostic.Status != "unsupported" || c.Match != nil {
			t.Fatal(c.Diagnostic)
		}
	}
	c := compile(testRule("fingerprinthub", `{"http":[{"path":["{{BaseURL}}/"],"matchers":[{"type":"word","words":["vbmarker"]}],"extractors":[{"type":"regex","regex":["(?x)version"]}]}]}`))
	if c.Diagnostic.Status != "partial" {
		t.Fatal(c.Diagnostic)
	}
	hit, version, _ := c.Match(testInput("vbmarker", "/"))
	if !hit || version != "" {
		t.Fatal("extractor limitation must retain product-only matching")
	}
}
