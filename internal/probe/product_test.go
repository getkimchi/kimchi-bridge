package probe

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProductCopyKeepsPackagedHelperExecutable(t *testing.T) {
	root := t.TempDir()
	product := filepath.Join(root, "product")
	if err := os.WriteFile(product, []byte("fixture executable"), 0700); err != nil {
		t.Fatal(err)
	}
	plugin := filepath.Join(root, "plugin")
	if err := os.MkdirAll(filepath.Join(plugin, "bin"), 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(plugin, "bin", "kimchi-adapters")
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := copyProductBinary(product, plugin); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatal("existing packaged helper is not executable", info, err)
	}
}
