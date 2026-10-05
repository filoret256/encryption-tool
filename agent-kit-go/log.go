// What an agent says on stderr, and how anything a request sent is made safe
// to say there.
package agentkit

import (
	"fmt"
	"os"
	"unicode"
)

// Name prefixes every line this package writes: "code-agent", "kafka-agent".
// Set once by the binary before anything runs — each agent is a process of
// its own, so one package-level value is one per agent.
var Name = "agent"

// Lifecycle reports a connection coming or going, on stderr rather than stdout.
//
// stdout carries exactly one thing scripts parse — the URL with the token — and
// a line arriving there later, on somebody else's schedule, is the kind of
// thing that breaks a pipe reader six months from now.
func Lifecycle(message string) {
	fmt.Fprintf(os.Stderr, "%s: %s\n", Name, Printable(message))
}

// Printable makes a value from a request safe to write to a terminal.
//
// The Origin and Host of a request are chosen by whoever sends it, and they are
// echoed to the operator's terminal when refused. A control character in one is
// not text there but an instruction: an escape sequence can move the cursor,
// overwrite the lines above and make a refusal look like something else — or
// like nothing. Every control character becomes "?", and a value longer than a
// line is cut, so nothing sent over the socket can rewrite what the operator
// reads.
func Printable(s string) string {
	const longest = 300
	out := make([]rune, 0, len(s))
	for _, r := range s {
		if len(out) == longest {
			out = append(out, '…')
			break
		}
		if unicode.IsControl(r) {
			r = '?'
		}
		out = append(out, r)
	}
	return string(out)
}

// Refuse logs why a request was turned away and reports it as not allowed.
//
// From the browser's side a rejected upgrade looks exactly like an agent that
// is not running, so without this line the user goes off to debug a process
// that is doing precisely what it was told.
func Refuse(what, value, hint string) bool {
	if value == "" {
		value = "(none)"
	}
	fmt.Fprintf(os.Stderr, "%s: refused %s %s — %s\n", Name, Printable(what), Printable(value), Printable(hint))
	return false
}
