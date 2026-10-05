package main

import (
	"strings"
	"testing"

	"github.com/twmb/franz-go/pkg/kgo"
)

// The filter used to lower-case a copy of the key and of the value of every record. It must
// answer exactly as that did — including for letters whose lower case is another rune, and for
// bytes that are not UTF-8 — while allocating nothing.
func TestContainsFoldAgreesWithLowerCasingACopy(t *testing.T) {
	haystacks := []string{
		"", "a", "Hello, World", "ORDER-42 shipped", "straße Straße STRASSE", "Ünïcödé ÜNÏCÖDÉ",
		"Привет МИР", "日本語のテキスト", "K the Kelvin sign: K", "İstanbul İSTANBUL", "mixed \xff\xfe bytes ABC",
		strings.Repeat("ab", 500) + "NEEDLE" + strings.Repeat("cd", 500),
	}
	needles := []string{
		"", "a", "hello", "WORLD", "order-42", "straße", "ünï", "мир", "テキスト", "k", "K",
		"i̇stanbul", "bytes abc", "needle", "zzz", "abab", "\xff",
	}
	for _, h := range haystacks {
		for _, n := range needles {
			lowered := strings.ToLower(n)
			want := strings.Contains(strings.ToLower(h), lowered)
			if got := containsFold([]byte(h), []rune(lowered)); got != want {
				t.Errorf("containsFold(%q, %q) = %v, want %v", h, n, got, want)
			}
		}
	}
}

func TestCaseInsensitiveFilterAllocatesNothing(t *testing.T) {
	match, err := makeFilter(consumeParams{Filter: "Needle"})
	if err != nil {
		t.Fatal(err)
	}
	rec := &kgo.Record{Key: []byte("some-key"), Value: []byte(strings.Repeat("value with some text ", 5000) + "a NEEDLE here")}
	if !match(rec) {
		t.Fatal("the filter missed a record that holds the text in another case")
	}
	if allocs := testing.AllocsPerRun(20, func() { _ = match(rec) }); allocs != 0 {
		t.Fatalf("the filter allocated %v times per record, want none", allocs)
	}
}
