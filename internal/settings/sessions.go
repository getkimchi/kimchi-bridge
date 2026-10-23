package settings

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/getkimchi/kimchi-adapters/internal/delivery"
	"github.com/getkimchi/kimchi-adapters/protocol"
)

// A login change must not relabel an already running native session. This
// registry contains only account-directory IDs, never reporting credentials.
func SessionStateDir(c Config, source, session string) (string, error) {
	if (source != "codex" && source != "claude-code") || session == "" || len(session) > 512 || strings.ContainsAny(session, "\x00\r\n") {
		return "", errors.New("invalid native session")
	}
	dir := filepath.Join(Root(), "session-accounts")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, protocol.StableID(source, session)+".json")
	if _, err := os.Stat(path); os.IsNotExist(err) {
		body, err := json.Marshal(filepath.Base(c.StateDir()))
		if err != nil {
			return "", err
		}
		f, err := os.CreateTemp(dir, ".binding-")
		if err != nil {
			return "", err
		}
		defer os.Remove(f.Name())
		if _, err = f.Write(body); err == nil {
			err = f.Sync()
		}
		closeErr := f.Close()
		if err == nil {
			err = closeErr
		}
		if err != nil {
			return "", err
		}
		if err = os.Link(f.Name(), path); err != nil && !os.IsExist(err) {
			return "", err
		}
	}
	parent, err := os.Open(dir)
	if err != nil {
		return "", err
	}
	err = parent.Sync()
	parent.Close()
	if err != nil {
		return "", err
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var account string
	if len(body) > 256 || json.Unmarshal(body, &account) != nil || (account != "local" && !delivery.ValidID(account)) {
		return "", errors.New("invalid native account binding")
	}
	return filepath.Join(Root(), "accounts", account), nil
}
