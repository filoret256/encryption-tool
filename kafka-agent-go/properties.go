// Java .properties files — the format people already keep their Kafka client
// settings in, for kafka-console-consumer and every JVM client.
//
// Written out rather than taken from a library: the format is one page of
// java.util.Properties#load, and a dependency for it would be one more thing
// the SCA scan has to clear for a parser this size.
package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// property is one key=value, with the line it started on for error messages.
type property struct {
	key, value string
	line       int
}

// parseProperties reads the format java.util.Properties#load reads:
//
//   - '#' or '!' as the first non-blank character starts a comment line;
//   - a line ending in an odd number of backslashes continues on the next,
//     whose leading whitespace is dropped;
//   - the key ends at the first unescaped '=', ':' or whitespace; blanks and
//     one '=' or ':' after it are skipped;
//   - \t \n \r \f \uXXXX are escapes, and a backslash before anything else
//     stands for that character.
//
// A later key replaces an earlier one, as in Java. The text is taken as UTF-8
// rather than Java's ISO-8859-1: a password with a non-ASCII character is far
// more likely to have been typed in UTF-8 than escaped as \uXXXX.
func parseProperties(text string) ([]property, error) {
	lines := strings.Split(strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n"), "\n")
	var out []property
	for i := 0; i < len(lines); i++ {
		start := i + 1
		line := strings.TrimLeft(lines[i], " \t\f")
		if line == "" || line[0] == '#' || line[0] == '!' {
			continue
		}
		for continues(line) && i+1 < len(lines) {
			i++
			line = line[:len(line)-1] + strings.TrimLeft(lines[i], " \t\f")
		}
		if continues(line) {
			line = line[:len(line)-1] // a continuation at end of file continues into nothing
		}

		key, rest, err := splitKey(line)
		if err != nil {
			return nil, fmt.Errorf("line %d: %v", start, err)
		}
		value, err := unescape(rest)
		if err != nil {
			return nil, fmt.Errorf("line %d: %v", start, err)
		}
		out = append(out, property{key: key, value: value, line: start})
	}
	return out, nil
}

// continues reports whether a line ends in an odd number of backslashes.
func continues(line string) bool {
	n := 0
	for i := len(line) - 1; i >= 0 && line[i] == '\\'; i-- {
		n++
	}
	return n%2 == 1
}

func splitKey(line string) (string, string, error) {
	end := len(line)
	for i := 0; i < len(line); i++ {
		c := line[i]
		if c == '\\' {
			i++ // the next character is part of the key, whatever it is
			continue
		}
		if c == '=' || c == ':' || c == ' ' || c == '\t' || c == '\f' {
			end = i
			break
		}
	}
	key, err := unescape(line[:end])
	if err != nil {
		return "", "", err
	}
	rest := strings.TrimLeft(line[end:], " \t\f")
	if rest != "" && (rest[0] == '=' || rest[0] == ':') {
		rest = strings.TrimLeft(rest[1:], " \t\f")
	}
	return key, rest, nil
}

func unescape(s string) (string, error) {
	if !strings.Contains(s, `\`) {
		return s, nil
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] != '\\' || i+1 == len(s) {
			b.WriteByte(s[i])
			continue
		}
		i++
		switch s[i] {
		case 't':
			b.WriteByte('\t')
		case 'n':
			b.WriteByte('\n')
		case 'r':
			b.WriteByte('\r')
		case 'f':
			b.WriteByte('\f')
		case 'u':
			if len(s) < i+5 {
				return "", fmt.Errorf(`malformed \u escape`)
			}
			n, err := strconv.ParseUint(s[i+1:i+5], 16, 16)
			if err != nil {
				return "", fmt.Errorf(`malformed \u escape: \u%s`, s[i+1:i+5])
			}
			b.WriteRune(rune(n))
			i += 4
		default:
			b.WriteByte(s[i])
		}
	}
	return b.String(), nil
}

// readProperties loads a properties file, with errors naming it.
func readProperties(path string) ([]property, error) {
	raw, err := os.ReadFile(path) // #nosec G304 -- the operator's own config file, named by them
	if err != nil {
		return nil, fmt.Errorf("cannot read %s: %v", path, err)
	}
	props, err := parseProperties(string(raw))
	if err != nil {
		return nil, fmt.Errorf("%s: %v", path, err)
	}
	return props, nil
}
