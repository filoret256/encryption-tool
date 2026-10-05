package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestExpandHome(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home directory on this machine")
	}
	for in, want := range map[string]string{
		"~":           home,
		"~/a/b":       filepath.Join(home, "a", "b"),
		`~\a`:         filepath.Join(home, "a"),
		"/abs/~/x":    "/abs/~/x",
		"~someone":    "~someone", // another user's home is not expanded
		"relative/~x": "relative/~x",
	} {
		if got := expandHome(in); got != want {
			t.Errorf("expandHome(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestStoreTypes(t *testing.T) {
	for in, want := range map[string]string{"JKS": "JKS", "PKCS12": "PKCS12", "P12": "PKCS12", "PFX": "PKCS12", "PEM": "PEM", "": ""} {
		got, err := storeType(in)
		if err != nil || got != want {
			t.Errorf("storeType(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	if _, err := storeType("BKS"); err == nil || !strings.Contains(err.Error(), "JKS, PKCS12, PEM") {
		t.Errorf("an unknown store type should say what is read: %v", err)
	}
}

func TestSplitList(t *testing.T) {
	want := []string{"a:1", "b:2", "c:3"}
	for _, in := range []string{"a:1,b:2,c:3", "a:1, b:2 ,c:3", "a:1 b:2\tc:3", ",a:1,,b:2,\nc:3,"} {
		if got := splitList(in); !reflect.DeepEqual(got, want) {
			t.Errorf("splitList(%q) = %v", in, got)
		}
	}
	if got := splitList(" , "); len(got) != 0 {
		t.Errorf("nothing but separators: %v", got)
	}
}

func TestYAMLBootstrapAsListOrString(t *testing.T) {
	dir := write(t, map[string]string{"kafka-agent.yaml": `clusters:
  - name: a
    bootstrap: [k1:9092, k2:9092]
  - name: b
    bootstrap: "k3:9092, k4:9092"
  - name: c
    bootstrap: k5:9092
    properties:
      client.id: probe
      request.timeout.ms: "5000"
`})
	list, _, err := loadClusters(clusterFlags{config: filepath.Join(dir, "kafka-agent.yaml")})
	if err != nil {
		t.Fatal(err)
	}
	for i, want := range [][]string{{"k1:9092", "k2:9092"}, {"k3:9092", "k4:9092"}, {"k5:9092"}} {
		if !reflect.DeepEqual(list[i].Bootstrap, want) {
			t.Errorf("cluster %s: %v, want %v", list[i].Name, list[i].Bootstrap, want)
		}
	}
	// Properties given inline are read like a file's: what the agent does not use is said once.
	var noted bool
	for _, w := range list[2].Warnings {
		noted = noted || strings.Contains(w, "client.id")
	}
	if !noted {
		t.Errorf("an ignored inline property should be noted: %v", list[2].Warnings)
	}
}

func TestYAMLPropertiesMustBeAPathOrAMapping(t *testing.T) {
	for name, body := range map[string]string{
		"a list":            "clusters:\n  - name: a\n    bootstrap: k:9092\n    properties: [x, y]\n",
		"a nested mapping":  "clusters:\n  - name: a\n    bootstrap: k:9092\n    properties:\n      ssl:\n        a: b\n",
		"an unknown key":    "clusters:\n  - name: a\n    bootstrap: k:9092\n    trustore: x\n",
		"no bootstrap":      "clusters:\n  - name: a\n",
		"a twice-used name": "clusters:\n  - name: a\n    bootstrap: k:9092\n  - name: a\n    bootstrap: k2:9092\n",
	} {
		dir := write(t, map[string]string{"kafka-agent.yaml": body})
		_, _, err := loadClusters(clusterFlags{config: filepath.Join(dir, "kafka-agent.yaml")})
		if err == nil {
			t.Errorf("%s: accepted", name)
			continue
		}
		if !strings.Contains(err.Error(), "kafka-agent.yaml") {
			t.Errorf("%s: the error should name the file: %v", name, err)
		}
	}
}

func TestWarningsAreSaidOnce(t *testing.T) {
	a := &cluster{Warnings: []string{"x", "y"}}
	b := &cluster{Warnings: []string{"y", "z"}}
	if got := warningsOf([]*cluster{a, b}); !reflect.DeepEqual(got, []string{"x", "y", "z"}) {
		t.Errorf("warnings: %v", got)
	}
	if got := warningsOf(nil); got == nil || len(got) != 0 {
		t.Errorf("no warnings must be an empty list, not nil (it is JSON): %#v", got)
	}
}

func TestUnwrapPathError(t *testing.T) {
	_, err := os.ReadFile(filepath.Join(t.TempDir(), "missing"))
	if got := unwrapPathError(err); got == err || strings.Contains(got.Error(), "missing") {
		t.Errorf("the path should be dropped, leaving the reason: %v", got)
	}
	plain := fs.ErrInvalid
	if unwrapPathError(plain) != plain {
		t.Error("an error that is not a path error passes through")
	}
}
