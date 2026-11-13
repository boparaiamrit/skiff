package main

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"
	"github.com/ulikunitz/xz"
)

var httpClient = &http.Client{Timeout: 0, Transport: &http.Transport{
	Proxy:               http.ProxyFromEnvironment,
	TLSHandshakeTimeout: 20 * time.Second,
	IdleConnTimeout:     60 * time.Second,
}}

// fetch downloads url into memory (for small files such as indexes).
func fetch(ctx context.Context, url string) ([]byte, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("User-Agent", "skiff/"+version)
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("GET %s: %s", url, resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 64<<20))
}

// download saves url to dst, reporting progress, and checks sha256 when given.
func download(ctx context.Context, url, dst, sha string, progress func(done, total int64)) error {
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("User-Agent", "skiff/"+version)
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("GET %s: %s", url, resp.Status)
	}
	tmp := dst + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	h := sha256.New()
	total := resp.ContentLength
	var done int64
	buf := make([]byte, 256<<10)
	last := time.Now()
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, err := f.Write(buf[:n]); err != nil {
				f.Close()
				return err
			}
			h.Write(buf[:n])
			done += int64(n)
			if progress != nil && time.Since(last) > 300*time.Millisecond {
				progress(done, total)
				last = time.Now()
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			f.Close()
			return rerr
		}
	}
	if err := f.Close(); err != nil {
		return err
	}
	if progress != nil {
		progress(done, total)
	}
	if sha != "" {
		got := hex.EncodeToString(h.Sum(nil))
		if !strings.EqualFold(got, sha) {
			return fmt.Errorf("checksum mismatch for %s: got %s want %s", filepath.Base(dst), got, sha)
		}
	}
	return os.Rename(tmp, dst)
}

// decompress wraps r according to the file name's extension.
func decompress(name string, r io.Reader) (io.Reader, error) {
	switch {
	case strings.HasSuffix(name, ".gz"):
		return gzip.NewReader(r)
	case strings.HasSuffix(name, ".xz"):
		return xz.NewReader(bufio.NewReaderSize(r, 1<<20))
	case strings.HasSuffix(name, ".zst"):
		d, err := zstd.NewReader(r)
		if err != nil {
			return nil, err
		}
		return d.IOReadCloser(), nil
	}
	return r, nil
}

// debData returns a reader for the data.tar.* member of a .deb (an ar archive).
func debData(path string) (io.Reader, string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, "", err
	}
	if !bytes.HasPrefix(b, []byte("!<arch>\n")) {
		return nil, "", errors.New("not a .deb (ar) file")
	}
	off := 8
	for off+60 <= len(b) {
		hdr := b[off : off+60]
		name := strings.TrimRight(strings.TrimSpace(string(hdr[0:16])), "/")
		var size int
		fmt.Sscanf(strings.TrimSpace(string(hdr[48:58])), "%d", &size)
		off += 60
		if off+size > len(b) {
			break
		}
		data := b[off : off+size]
		if strings.HasPrefix(name, "data.tar") {
			r, err := decompress(name, bytes.NewReader(data))
			return r, name, err
		}
		off += size
		if off%2 == 1 {
			off++
		}
	}
	return nil, "", errors.New("no data.tar in .deb")
}

// extractTar unpacks a tar stream into dst. mapName may rename or drop
// (return "") entries. Hard links become copies: Android forbids them in
// app storage.
func extractTar(r io.Reader, dst string, mapName func(string) string, onFile func(n int)) error {
	tr := tar.NewReader(r)
	var hardlinks [][2]string
	count := 0
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		name := h.Name
		if mapName != nil {
			name = mapName(name)
			if name == "" {
				continue
			}
		}
		clean := filepath.Clean("/" + name)
		if clean == "/" {
			continue
		}
		target := filepath.Join(dst, clean)
		mode := os.FileMode(h.Mode).Perm()
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, mode|0o700); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			_ = os.MkdirAll(filepath.Dir(target), 0o755)
			_ = os.Remove(target)
			f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode|0o600)
			if err != nil {
				return err
			}
			if _, err := io.Copy(f, tr); err != nil {
				f.Close()
				return err
			}
			f.Close()
			if h.Mode&0o7000 != 0 {
				_ = os.Chmod(target, mode|0o600)
			}
		case tar.TypeSymlink:
			_ = os.MkdirAll(filepath.Dir(target), 0o755)
			_ = os.RemoveAll(target)
			if err := os.Symlink(h.Linkname, target); err != nil {
				return err
			}
		case tar.TypeLink:
			src := h.Linkname
			if mapName != nil {
				src = mapName(src)
			}
			hardlinks = append(hardlinks, [2]string{filepath.Join(dst, filepath.Clean("/"+src)), target})
		default:
			continue // devices, fifos
		}
		count++
		if onFile != nil && count%500 == 0 {
			onFile(count)
		}
	}
	for _, hl := range hardlinks {
		if err := copyFile(hl[0], hl[1]); err != nil {
			return fmt.Errorf("hard link %s: %w", hl[1], err)
		}
	}
	if onFile != nil {
		onFile(count)
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	st, err := in.Stat()
	if err != nil {
		return err
	}
	_ = os.MkdirAll(filepath.Dir(dst), 0o755)
	_ = os.Remove(dst)
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, st.Mode().Perm()|0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// debPackage is one stanza of an apt Packages index.
type debPackage struct {
	Name, Version, Depends, Filename, SHA256 string
}

func parsePackages(b []byte) map[string]debPackage {
	out := map[string]debPackage{}
	for _, stanza := range strings.Split(string(b), "\n\n") {
		var p debPackage
		for _, line := range strings.Split(stanza, "\n") {
			k, v, ok := strings.Cut(line, ": ")
			if !ok {
				continue
			}
			switch k {
			case "Package":
				p.Name = v
			case "Version":
				p.Version = v
			case "Depends":
				p.Depends = v
			case "Filename":
				p.Filename = v
			case "SHA256":
				p.SHA256 = v
			}
		}
		if p.Name != "" && p.Filename != "" {
			out[p.Name] = p
		}
	}
	return out
}

func depNames(depends string) []string {
	var out []string
	for _, d := range strings.Split(depends, ",") {
		d = strings.TrimSpace(strings.Split(d, "|")[0])
		if i := strings.IndexAny(d, " ("); i >= 0 {
			d = d[:i]
		}
		d = strings.TrimSuffix(d, ":any")
		if d != "" {
			out = append(out, d)
		}
	}
	return out
}
