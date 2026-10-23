package main

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestBootstrapRejectsCorruptAndUnsafeArchives(t *testing.T) {
	installer, err := filepath.Abs("../../install.sh")
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"checksum", "traversal", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			bin := filepath.Join(root, "fake-bin")
			if err := os.Mkdir(bin, 0700); err != nil {
				t.Fatal(err)
			}
			name := "kimchi-adapters_" + runtime.GOOS + "_" + runtime.GOARCH + ".tar.gz"
			asset := filepath.Join(root, name)
			f, err := os.Create(asset)
			if err != nil {
				t.Fatal(err)
			}
			zip := gzip.NewWriter(f)
			archive := tar.NewWriter(zip)
			header := &tar.Header{Name: "../escaped", Typeflag: tar.TypeReg, Mode: 0600, Size: 1}
			if kind == "symlink" {
				header = &tar.Header{Name: "link", Typeflag: tar.TypeSymlink, Linkname: "/tmp/unowned", Mode: 0700}
			}
			if err = archive.WriteHeader(header); err != nil {
				t.Fatal(err)
			}
			if header.Typeflag == tar.TypeReg {
				if _, err = archive.Write([]byte("x")); err != nil {
					t.Fatal(err)
				}
			}
			if err = archive.Close(); err != nil {
				t.Fatal(err)
			}
			if err = zip.Close(); err != nil {
				t.Fatal(err)
			}
			if err = f.Close(); err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(asset)
			if err != nil {
				t.Fatal(err)
			}
			hash := fmt.Sprintf("%x", sha256.Sum256(data))
			if kind == "checksum" {
				hash = strings.Repeat("0", 64)
			}
			sums := filepath.Join(root, "SHA256SUMS")
			if err = os.WriteFile(sums, []byte(hash+"  "+name+"\n"), 0600); err != nil {
				t.Fatal(err)
			}
			gh := `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = --dir ]; then dest=$2;shift 2;else shift;fi
done
cp "$FIXTURE_ASSET" "$dest/$FIXTURE_NAME"
cp "$FIXTURE_SUMS" "$dest/SHA256SUMS"
`
			if err = os.WriteFile(filepath.Join(bin, "gh"), []byte(gh), 0700); err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(filepath.Join(bin, "claude"), []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command("bash", installer, "install", "claude", "v0.1.0-rc.1")
			cmd.Env = []string{"HOME=" + root, "PATH=" + bin + ":/usr/bin:/bin", "KIMCHI_ADAPTERS_PREFIX=" + root + "/install", "KIMCHI_ADAPTERS_BIN_DIR=" + root + "/bin", "FIXTURE_ASSET=" + asset, "FIXTURE_SUMS=" + sums, "FIXTURE_NAME=" + name}
			out, err := cmd.CombinedOutput()
			if err == nil {
				t.Fatal("unsafe archive accepted", string(out))
			}
			want := map[string]string{"checksum": "checksum mismatch", "traversal": "Unsafe release archive", "symlink": "links or special files"}[kind]
			if !strings.Contains(string(out), want) {
				t.Fatal("failed for an unrelated reason", string(out))
			}
			if _, err = os.Stat(filepath.Join(root, "escaped")); !os.IsNotExist(err) {
				t.Fatal("archive escaped staging")
			}
		})
	}
}
