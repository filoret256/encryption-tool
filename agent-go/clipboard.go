// Putting the connection URL on the system clipboard at startup.
//
// The URL carries a token that is new on every run, so without this the first
// thing anyone does after starting the agent is select a line of terminal
// output with the mouse. There is no way for a process to offer a "copy"
// button in a terminal — catching a keypress would mean holding the terminal in
// raw mode, which breaks Ctrl+C, pipes, and running without a TTY at all — so
// the agent simply does the copying itself.
//
// Shelling out to the platform's clipboard tool rather than taking a
// dependency: each is one process spawn, they are the tools the user's desktop
// already ships, and a Go clipboard library would pull in cgo and X11 headers
// for something this small.
package main

import (
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// clipboardTools lists the candidate commands for this platform, in the order
// they should be tried. Each reads the text from stdin.
//
// Linux has no single answer: wl-copy is Wayland, xclip and xsel are X11, and a
// desktop may have any combination installed. Wayland comes first because a
// session running it usually also has XWayland, where an X11 tool would put the
// text on a clipboard the compositor's own applications do not read.
func clipboardTools() [][]string {
	switch runtime.GOOS {
	case "windows":
		return [][]string{{"clip"}}
	case "darwin":
		return [][]string{{"pbcopy"}}
	default:
		return [][]string{
			{"wl-copy"},
			{"xclip", "-selection", "clipboard"},
			{"xsel", "--clipboard", "--input"},
		}
	}
}

// copyToClipboard reports whether the text reached the clipboard. A failure is
// not an error worth stopping for: the URL is printed either way, and the whole
// feature is a convenience.
func copyToClipboard(text string) bool {
	for _, argv := range clipboardTools() {
		path, err := exec.LookPath(argv[0])
		if err != nil {
			continue // not installed; try the next one
		}
		cmd := exec.Command(path, argv[1:]...)
		cmd.Stdin = strings.NewReader(text)
		if cmd.Run() == nil {
			return true
		}
	}
	return false
}

// interactive reports whether stdout is a terminal a person is watching.
//
// This gates the copy, and gating it matters: the smoke suite starts agents in
// a loop with their output piped, and every one of them would otherwise
// overwrite whatever the developer had on their clipboard.
func interactive() bool {
	info, err := os.Stdout.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}
