package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"enc-tool/kafka-agent/internal/testpki"
)

func TestWhoCanReadIsSaidPlainly(t *testing.T) {
	for _, c := range []struct {
		mode fs.FileMode
		want string // "" for silence, else a fragment of the warning
	}{
		{0o600, ""},
		{0o400, ""},
		{0o700, ""},
		{0o640, "its group"},
		{0o660, "its group"},
		{0o644, "every user on this machine"},
		{0o604, "every user on this machine"},
		{0o666, "every user on this machine"},
	} {
		got := permWarning("/etc/kafka/client.properties", c.mode)
		if c.want == "" {
			if got != "" {
				t.Errorf("mode %04o warned: %s", c.mode, got)
			}
			continue
		}
		if !strings.Contains(got, c.want) || !strings.Contains(got, "chmod 600 /etc/kafka/client.properties") {
			t.Errorf("mode %04o: %q", c.mode, got)
		}
	}
}

func TestWarningsAreOncePerFileAndSkipWhatIsNotThere(t *testing.T) {
	modes := map[string]fs.FileMode{
		"/a/b.yaml": 0o644,
		"/a/a.p12":  0o600,
		"/a/dir":    fs.ModeDir | 0o755,
		"/a/c.key":  0o640,
	}
	stat := func(p string) (fs.FileMode, error) {
		if m, ok := modes[p]; ok {
			return m, nil
		}
		return 0, errors.New("gone")
	}
	paths := []string{"/a/b.yaml", "/a/c.key", "/a/b.yaml", "/a/a.p12", "/a/dir", "/a/missing", ""}
	got := permissionWarnings(paths, stat, "linux")
	if len(got) != 2 || !strings.HasPrefix(got[0], "/a/b.yaml") || !strings.HasPrefix(got[1], "/a/c.key") {
		t.Fatalf("warnings: %q — want b.yaml and c.key, once each, in path order", got)
	}
	if w := permissionWarnings(paths, stat, "windows"); w != nil {
		t.Errorf("on Windows the mode bits mean nothing, and there was a warning: %q", w)
	}
}

func TestEveryFileThatHoldsASecretIsNoted(t *testing.T) {
	pki, err := testpki.New()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := pki.WriteFiles(dir); err != nil {
		t.Fatal(err)
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.WriteFile(filepath.Join(dir, "secret.txt"), []byte("app-secret\n"), 0o600))
	yamlPath := filepath.Join(dir, "cluster.yaml")
	must(os.WriteFile(yamlPath, []byte(`clusters:
  - name: viaprops
    bootstrap: h:1
    properties: client-ssl-p12.properties
  - name: direct
    bootstrap: h:2
    security:
      protocol: SASL_SSL
      tls:
        truststore: { location: truststore.p12, password: changeit }
        keystore: { location: client.p12, type: PKCS12, password: changeit }
      sasl: { mechanism: SCRAM-SHA-512, username: app, password: "${file:secret.txt}" }
  - name: pem
    bootstrap: h:3
    security:
      protocol: SSL
      tls: { ca: ca.pem, cert: client.pem, key: client.key }
`), 0o600))

	list, _, err := loadClusters(clusterFlags{config: yamlPath})
	if err != nil {
		t.Fatal(err)
	}
	has := func(c *cluster, want string) bool {
		for _, f := range c.secretFiles {
			if f == filepath.Join(dir, want) || f == want {
				return true
			}
		}
		return false
	}
	byName := map[string]*cluster{}
	for _, c := range list {
		byName[c.Name] = c
	}
	for cluster, files := range map[string][]string{
		"viaprops": {"cluster.yaml", "client-ssl-p12.properties", "client.p12"},
		"direct":   {"cluster.yaml", "client.p12", "secret.txt"},
		"pem":      {"cluster.yaml", "client.key"},
	} {
		for _, f := range files {
			if !has(byName[cluster], f) {
				t.Errorf("cluster %s: %s is not among the files checked (%v)", cluster, f, byName[cluster].secretFiles)
			}
		}
	}
	// A truststore and a certificate are public: nothing to warn about there.
	for _, f := range []string{"truststore.p12", "ca.pem", "client.pem"} {
		for _, c := range list {
			if has(c, f) {
				t.Errorf("%s holds no secret and was checked", f)
			}
		}
	}
}

func TestALooseConfigIsReportedWhenLoaded(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("permission bits mean nothing on Windows; the rule itself is tested above")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "kafka-agent.yaml")
	body := []byte("clusters:\n  - name: a\n    bootstrap: h:1\n")
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatal(err)
	}
	list, _, err := loadClusters(clusterFlags{config: path})
	if err != nil {
		t.Fatal(err)
	}
	if w := warningsOf(list); len(w) != 1 || !strings.Contains(w[0], "chmod 600") {
		t.Fatalf("a world-readable config: %q", w)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	list, _, _ = loadClusters(clusterFlags{config: path})
	if w := warningsOf(list); len(w) != 0 {
		t.Fatalf("a private config still warned: %q", w)
	}
}
