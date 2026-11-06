package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestCorpus runs BuildKit over every case, so `go test -coverpkg` reports
// how much of BuildKit's parser, lexer and instruction checks the corpus
// reaches:
//
//	go test -coverpkg=github.com/moby/buildkit/frontend/dockerfile/... -coverprofile=cover.out .
func TestCorpus(t *testing.T) {
	dirs, err := filepath.Glob("../cases/*/Dockerfile")
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range dirs {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		read(data)
	}
	words(filepath.Join("..", "words"))
}
