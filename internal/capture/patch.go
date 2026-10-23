package capture

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
)

func patchInput(e Object) string {
	input := toolInput(e)
	patch := str(input, "patch", "input")
	if s, ok := e["tool_input"].(string); ok {
		patch = s
	}
	if patch == "" {
		command := strings.TrimSpace(str(input, "cmd", "command"))
		if strings.HasPrefix(command, "apply_patch '") && strings.HasSuffix(command, "'") {
			value := command[len("apply_patch '") : len(command)-1]
			if !strings.Contains(value, "'") {
				patch = value
			}
		}
	}
	patch = strings.TrimSpace(patch)
	if strings.HasPrefix(patch, "*** Begin Patch\n") && strings.HasSuffix(patch, "\n*** End Patch") {
		return patch
	}
	return ""
}

// Match the official apply_patch grammar conservatively. Fuzzy contexts,
// renames and arbitrary shell scripts remain observed, never confirmed edits.
func (r *Recorder) patchExpected(before fileState, e Object, root, path string) (string, bool) {
	patch := patchInput(e)
	if patch == "" {
		return "", false
	}
	lines := strings.Split(patch, "\n")
	kind := ""
	var block []string
	active := false
	for _, line := range lines[1:] {
		if strings.HasPrefix(line, "*** ") && line != "*** End of File" {
			if active {
				if strings.HasPrefix(line, "*** Move to:") {
					return "", false
				}
				break
			}
			for _, prefix := range []string{"*** Add File: ", "*** Update File: ", "*** Delete File: "} {
				if strings.HasPrefix(line, prefix) {
					target := strings.TrimPrefix(line, prefix)
					if !filepath.IsAbs(target) {
						target = filepath.Join(root, target)
					}
					if filepath.Clean(target) == path {
						active = true
						kind = prefix
					}
				}
			}
		} else if active {
			block = append(block, line)
		}
	}
	if !active {
		return "", false
	}
	if kind == "*** Delete File: " {
		return "", before.Exists
	}
	if kind == "*** Add File: " {
		var added []string
		for _, line := range block {
			if !strings.HasPrefix(line, "+") {
				return "", false
			}
			added = append(added, line[1:])
		}
		if len(added) == 0 {
			return "", false
		}
		return digest([]byte(strings.Join(added, "\n") + "\n")), true
	}
	if !before.Exists {
		return "", false
	}
	content, err := os.ReadFile(filepath.Join(r.Store.Dir, "blobs", before.Hash))
	if err != nil {
		return "", false
	}
	current := strings.Split(strings.TrimSuffix(string(content), "\n"), "\n")
	cursor := 0
	changed := false
	for i := 0; i < len(block); {
		if strings.HasPrefix(block[i], "@@") {
			i++
			continue
		}
		var old, replacement []string
		eof := false
		for i < len(block) && !strings.HasPrefix(block[i], "@@") {
			line := block[i]
			i++
			if line == "*** End of File" {
				eof = true
				break
			}
			if line == "" {
				return "", false
			}
			switch line[0] {
			case ' ':
				old = append(old, line[1:])
				replacement = append(replacement, line[1:])
			case '-':
				old = append(old, line[1:])
			case '+':
				replacement = append(replacement, line[1:])
			default:
				return "", false
			}
		}
		if len(old) == 0 {
			return "", false
		}
		position := -1
		for at := cursor; at+len(old) <= len(current); at++ {
			if slices.Equal(current[at:at+len(old)], old) && (!eof || at+len(old) == len(current)) {
				if position >= 0 {
					return "", false
				}
				position = at
			}
		}
		if position < 0 {
			return "", false
		}
		next := append([]string(nil), current[:position]...)
		next = append(next, replacement...)
		next = append(next, current[position+len(old):]...)
		current = next
		cursor = position + len(replacement)
		changed = true
	}
	if !changed {
		return "", false
	}
	return digest([]byte(strings.Join(current, "\n") + "\n")), true
}
