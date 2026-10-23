package probe

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"

	"github.com/getkimchi/kimchi-adapters/internal/ledger"
)

func copyProductBinary(product, plugin string) error {
	b, err := os.ReadFile(product)
	if err != nil {
		return err
	}
	dir := filepath.Join(plugin, "bin")
	if err = os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "kimchi-adapters"), b, 0700)
}
func productEvidence(dir string) (int, bool, error) {
	s, err := ledger.Open(dir)
	if err != nil {
		return 0, false, err
	}
	defer s.Close()
	events, err := s.Events(context.Background())
	if err != nil {
		return 0, false, err
	}
	before := sha256.Sum256([]byte("before\n"))
	after := sha256.Sum256([]byte("after\n"))
	var count int
	err = s.DB.QueryRow(`SELECT count(*) FROM file_changes WHERE before_hash=? AND after_hash=?`, hex.EncodeToString(before[:]), hex.EncodeToString(after[:])).Scan(&count)
	return len(events), count > 0, err
}
