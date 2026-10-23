package probe

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

const MaxRecord = 4 << 20
const maxRecords = 256

// Save durably creates an independent record, including its directory entry.
// This probe is deliberately bounded; it is not the production outbox.
func Save(dir string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(data) > MaxRecord {
		return errors.New("record exceeds probe bound")
	}
	if err = os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	if len(entries) >= maxRecords {
		return errors.New("probe record limit")
	}
	f, err := os.CreateTemp(dir, ".pending-")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.Write(append(data, '\n')); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(name, name+".json"); err != nil {
		return err
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func Gap(state, code string) {
	if state != "" {
		_ = Save(filepath.Join(state, "gaps"), map[string]any{"code": code, "time": time.Now().UTC()})
	}
}

// Record snapshots only the explicitly configured synthetic fixture. It is not
// a general-purpose patch parser, filesystem watcher or source uploader.
func Record(state, file string, payload []byte) error {
	if !filepath.IsAbs(state) || !filepath.IsAbs(file) || len(payload) > MaxRecord {
		return errors.New("invalid recorder input")
	}
	var event map[string]any
	if err := json.Unmarshal(payload, &event); err != nil {
		return err
	}
	f, err := os.Open(file)
	var content []byte
	exists := err == nil
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if f != nil {
		content, err = io.ReadAll(io.LimitReader(f, MaxRecord+1))
		f.Close()
		if err != nil {
			return err
		}
		if len(content) > MaxRecord {
			return errors.New("fixture exceeds bound")
		}
	}
	return Save(filepath.Join(state, "events"), map[string]any{"time": time.Now().UTC(), "event": event, "snapshot": map[string]any{"exists": exists, "content": string(content)}})
}

func readRecords(dir string) ([]map[string]any, error) {
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for _, e := range entries {
		if filepath.Ext(e.Name()) != ".json" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, err
		}
		var v map[string]any
		if err = json.Unmarshal(b, &v); err != nil {
			return nil, fmt.Errorf("%s: %w", e.Name(), err)
		}
		out = append(out, v)
	}
	return out, nil
}
