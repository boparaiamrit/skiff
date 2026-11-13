package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDebExtract(t *testing.T) {
	m, _ := filepath.Glob("/tmp/debt/*.deb")
	if len(m) == 0 {
		t.Skip("no deb")
	}
	r, name, err := debData(m[0])
	if err != nil {
		t.Fatal(err)
	}
	dst := t.TempDir()
	n := 0
	if err := extractTar(r, dst, func(s string) string { return s }, func(c int) { n = c }); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dst, "usr/bin/proot")); err != nil {
		t.Fatalf("%s: proot missing: %v", name, err)
	}
	t.Logf("%s: %d entries", name, n)
}

func TestParsePackages(t *testing.T) {
	idx := parsePackages([]byte("Package: proot\nVersion: 5.1\nDepends: libtalloc (>= 2.1), libandroid-support | foo\nFilename: pool/main/p/proot.deb\nSHA256: ab\n\nPackage: libtalloc\nFilename: x.deb\n"))
	if idx["proot"].Filename != "pool/main/p/proot.deb" || len(depNames(idx["proot"].Depends)) != 2 {
		t.Fatalf("%+v %v", idx, depNames(idx["proot"].Depends))
	}
}
