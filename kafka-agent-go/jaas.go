package main

import (
	"fmt"
	"strings"
	"unicode"
)

// jaasEntry is one login module of a sasl.jaas.config value:
//
//	org.apache.kafka.common.security.scram.ScramLoginModule required username="app" password="…";
type jaasEntry struct {
	module  string
	flag    string
	options map[string]string
}

// parseJAAS reads the value Java clients put in sasl.jaas.config. Kafka parses
// it with a StreamTokenizer: words, '=' and ';' as separators, and values in
// double quotes with backslash escapes. A client config holds one module; a
// second one is an error rather than silently ignored, since it would be the
// credentials somebody expected to be used.
func parseJAAS(text string) (*jaasEntry, error) {
	toks, err := jaasTokens(text)
	if err != nil {
		return nil, err
	}
	if len(toks) < 3 || !toks[len(toks)-1].is(";") || toks[0].sep || toks[1].sep {
		return nil, fmt.Errorf("expected `<LoginModule> required key=\"value\" … ;`")
	}
	e := &jaasEntry{module: toks[0].text, flag: toks[1].text, options: map[string]string{}}
	switch strings.ToLower(e.flag) {
	case "required", "requisite", "sufficient", "optional":
	default:
		return nil, fmt.Errorf("%q is not a login module control flag (required, requisite, sufficient, optional)", e.flag)
	}
	rest := toks[2 : len(toks)-1]
	for i := 0; i < len(rest); i += 3 {
		if rest[i].is(";") {
			return nil, fmt.Errorf("more than one login module — a client uses exactly one")
		}
		if rest[i].sep || i+2 >= len(rest) || !rest[i+1].is("=") || rest[i+2].sep {
			return nil, fmt.Errorf("expected key=\"value\" after %q", rest[i].text)
		}
		e.options[rest[i].text] = rest[i+2].text
	}
	return e, nil
}

type jaasToken struct {
	text string
	// A separator: "=" or ";" outside quotes. A quoted "=" is a value.
	sep bool
}

func (t jaasToken) is(sep string) bool { return t.sep && t.text == sep }

// jaasTokens splits a JAAS value into words, quoted strings, "=" and ";".
// A quoted string is returned without its quotes.
func jaasTokens(text string) ([]jaasToken, error) {
	var out []jaasToken
	r := []rune(text)
	for i := 0; i < len(r); {
		c := r[i]
		switch {
		case unicode.IsSpace(c):
			i++
		case c == '=' || c == ';':
			out = append(out, jaasToken{text: string(c), sep: true})
			i++
		case c == '"':
			var b strings.Builder
			i++
			closed := false
			for i < len(r) {
				if r[i] == '\\' && i+1 < len(r) {
					b.WriteRune(r[i+1])
					i += 2
					continue
				}
				if r[i] == '"' {
					closed = true
					i++
					break
				}
				b.WriteRune(r[i])
				i++
			}
			if !closed {
				return nil, fmt.Errorf("unterminated quoted value")
			}
			out = append(out, jaasToken{text: b.String()})
		default:
			start := i
			for i < len(r) && !unicode.IsSpace(r[i]) && r[i] != '=' && r[i] != ';' && r[i] != '"' {
				i++
			}
			out = append(out, jaasToken{text: string(r[start:i])})
		}
	}
	return out, nil
}
