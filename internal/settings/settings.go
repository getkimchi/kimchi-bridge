package settings

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/getkimchi/kimchi-adapters/internal/delivery"
	"github.com/getkimchi/kimchi-adapters/protocol"
)

type Config struct {
	delivery.Config
	Disabled          bool   `json:"disabled,omitempty"`
	RuntimeExecutable string `json:"runtimeExecutable,omitempty"`
	RuntimeRevision   string `json:"runtimeRevision,omitempty"`
}

func Root() string {
	if p := os.Getenv("KIMCHI_ADAPTERS_HOME"); filepath.IsAbs(p) {
		return p
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "state", "kimchi-adapters")
}
func Load() (Config, error) {
	var c Config
	b, err := os.ReadFile(filepath.Join(Root(), "config.json"))
	if os.IsNotExist(err) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	err = json.Unmarshal(b, &c)
	return c, err
}
func (c Config) StateDir() string {
	account := "local"
	if c.Ready() == nil {
		account = protocol.StableID(c.APIURL, c.OrganizationID, c.ActorID)
	}
	return filepath.Join(Root(), "accounts", account)
}
func Save(c Config) error {
	if c.Enabled {
		if err := c.Ready(); err != nil {
			return err
		}
	}
	if err := os.MkdirAll(Root(), 0700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(Root(), ".config-")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err = f.Write(append(b, '\n')); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(tmp, filepath.Join(Root(), "config.json")); err != nil {
		return err
	}
	d, err := os.Open(Root())
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
func Decode(data []byte) (Config, error) {
	var c Config
	if len(data) > 32<<10 {
		return c, errors.New("configuration too large")
	}
	err := json.Unmarshal(data, &c)
	if err != nil {
		return c, errors.New("invalid configuration JSON")
	}
	// Runtime selection is written by the installed helper's activate command.
	// A copied reporting-login JSON must not become an executable selector.
	c.RuntimeExecutable = ""
	c.RuntimeRevision = ""
	if err = c.Validate(); err != nil {
		return c, err
	}
	return c, nil
}
