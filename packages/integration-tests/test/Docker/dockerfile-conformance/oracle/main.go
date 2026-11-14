// Command oracle writes, for every cases/<name>/Dockerfile, the expected.json
// that @alchemy.run/docker's DockerfileParser must produce. The expectation
// is BuildKit's own reading of the file: its parser and instruction layer,
// with Docker's word processing applied (quotes and escapes resolved) but no
// variable expanded, because the Alchemy parser leaves expansion to the
// builder.
//
//	go run . ../cases
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/moby/buildkit/frontend/dockerfile/instructions"
	"github.com/moby/buildkit/frontend/dockerfile/parser"
	"github.com/moby/buildkit/frontend/dockerfile/shell"
)

type flag struct {
	Name  string  `json:"name"`
	Value *string `json:"value"`
}

type heredoc struct {
	Name      string `json:"name"`
	Content   string `json:"content"`
	StripTabs bool   `json:"stripTabs"`
	Quoted    bool   `json:"quoted"`
}

type command struct {
	Form   string   `json:"form"`
	Argv   []string `json:"argv,omitempty"`
	Script *string  `json:"script,omitempty"`
}

type instruction struct {
	Tag         string       `json:"tag"`
	Line        int          `json:"line"`
	Flags       []flag       `json:"flags"`
	Command     *command     `json:"command,omitempty"`
	Heredocs    []heredoc    `json:"heredocs,omitempty"`
	Sources     []string     `json:"sources,omitempty"`
	Destination *string      `json:"destination,omitempty"`
	Vars        [][2]*string `json:"vars,omitempty"`
	Value       *string      `json:"value,omitempty"`
}

type stage struct {
	Line         int           `json:"line"`
	Image        string        `json:"image"`
	Name         *string       `json:"name"`
	Flags        []flag        `json:"flags"`
	Instructions []instruction `json:"instructions"`
}

type expected struct {
	OK         bool              `json:"ok"`
	Error      string            `json:"error,omitempty"`
	Directives map[string]string `json:"directives,omitempty"`
	GlobalArgs []instruction     `json:"globalArgs,omitempty"`
	Stages     []stage           `json:"stages,omitempty"`
}

type noEnv struct{}

func (noEnv) Get(string) (string, bool) { return "", false }
func (noEnv) Keys() []string            { return nil }

func str(s string) *string { return &s }

func main() {
	root := os.Args[1]
	entries, err := os.ReadDir(root)
	if err != nil {
		panic(err)
	}
	names := []string{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		names = append(names, entry.Name())
		dir := filepath.Join(root, entry.Name())
		data, err := os.ReadFile(filepath.Join(dir, "Dockerfile"))
		if err != nil {
			panic(err)
		}
		out, err := json.MarshalIndent(read(data), "", "  ")
		if err != nil {
			panic(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "expected.json"), append(out, '\n'), 0o644); err != nil {
			panic(err)
		}
		fmt.Println(entry.Name())
	}
	// The suite registers one test per case from this index.
	index, err := json.MarshalIndent(names, "", "  ")
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(root), "cases.json"), append(index, '\n'), 0o644); err != nil {
		panic(err)
	}
	words(filepath.Join(filepath.Dir(root), "words"))
}

// wordResult is one lexer mode's answer for one input.
type wordResult struct {
	OK    bool     `json:"ok"`
	Word  *string  `json:"word,omitempty"`
	Words []string `json:"words,omitempty"`
}

// words writes words/expected.json: BuildKit's shell lexer, with no
// environment, over every input in words/inputs.json, in each mode the
// Alchemy parser uses.
func words(dir string) {
	data, err := os.ReadFile(filepath.Join(dir, "inputs.json"))
	if err != nil {
		panic(err)
	}
	var inputs []string
	if err := json.Unmarshal(data, &inputs); err != nil {
		panic(err)
	}
	modes := map[string]func(string) wordResult{
		"word":           func(in string) wordResult { return word(shellLex('\\', false, false), in) },
		"wordBacktick":   func(in string) wordResult { return word(shellLex('`', false, false), in) },
		"words":          func(in string) wordResult { return split(shellLex('\\', false, false), in) },
		"wordsRawQuotes": func(in string) wordResult { return split(shellLex('\\', true, false), in) },
		"wordsRaw":       func(in string) wordResult { return split(shellLex('\\', true, true), in) },
	}
	out := []map[string]any{}
	for _, in := range inputs {
		entry := map[string]any{"input": in}
		for name, mode := range modes {
			entry[name] = mode(in)
		}
		out = append(out, entry)
	}
	encoded, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "expected.json"), append(encoded, '\n'), 0o644); err != nil {
		panic(err)
	}
}

func shellLex(escape rune, rawQuotes, rawEscapes bool) *shell.Lex {
	lex := shell.NewLex(escape)
	lex.SkipUnsetEnv = true
	lex.RawQuotes = rawQuotes
	lex.RawEscapes = rawEscapes
	return lex
}

func word(lex *shell.Lex, in string) wordResult {
	v, _, err := lex.ProcessWord(in, noEnv{})
	if err != nil {
		return wordResult{OK: false}
	}
	return wordResult{OK: true, Word: &v}
}

func split(lex *shell.Lex, in string) wordResult {
	ws, err := lex.ProcessWords(in, noEnv{})
	if err != nil {
		return wordResult{OK: false}
	}
	if ws == nil {
		ws = []string{}
	}
	return wordResult{OK: true, Words: ws}
}

type wordError struct{ err error }

// read reports a word Docker cannot process (an unterminated quote) as a
// failure, as the build would fail when the instruction runs.
func read(data []byte) (out expected) {
	defer func() {
		if r := recover(); r != nil {
			w, ok := r.(wordError)
			if !ok {
				panic(r)
			}
			out = expected{OK: false, Error: w.err.Error()}
		}
	}()
	return readDockerfile(data)
}

func readDockerfile(data []byte) expected {
	result, err := parser.Parse(strings.NewReader(string(data)))
	if err != nil {
		return expected{OK: false, Error: err.Error()}
	}
	stages, metaArgs, err := instructions.Parse(result.AST, nil)
	if err != nil {
		return expected{OK: false, Error: err.Error()}
	}
	// docker build expands every instruction's words before running it,
	// and validates what the parse defers (RUN --mount): with no variable
	// set, a failure here is a Dockerfile docker build rejects.
	{
		lex := shell.NewLex(result.EscapeToken)
		lex.SkipUnsetEnv = true
		expander := func(w string) (string, error) {
			v, _, err := lex.ProcessWord(w, noEnv{})
			return v, err
		}
		type expandable interface {
			Expand(instructions.SingleWordExpander) error
		}
		for i := range metaArgs {
			if err := metaArgs[i].Expand(expander); err != nil {
				return expected{OK: false, Error: err.Error()}
			}
		}
		for _, st := range stages {
			for _, cmd := range st.Commands {
				if e, ok := cmd.(expandable); ok {
					if err := e.Expand(expander); err != nil {
						return expected{OK: false, Error: err.Error()}
					}
				}
			}
		}
	}
	if len(stages) == 0 {
		// The parser accepts a file of global ARGs; docker build does not.
		return expected{OK: false, Error: "no build stage in current context"}
	}
	if len(result.AST.Children) == 0 {
		return expected{OK: false, Error: "file with no instructions"}
	}
	lex := shell.NewLex(result.EscapeToken)
	lex.SkipUnsetEnv = true
	word := func(w string) string {
		v, _, err := lex.ProcessWord(w, noEnv{})
		if err != nil {
			panic(wordError{err})
		}
		return v
	}

	directives := map[string]string{}
	dp := parser.DirectiveParser{}
	// As the parser does, a byte-order mark before the first directive is dropped.
	if all, err := dp.ParseAll(bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})); err == nil {
		for _, d := range all {
			directives[d.Name] = d.Value
		}
	}

	out := expected{OK: true, Directives: directives, GlobalArgs: []instruction{}, Stages: []stage{}}
	for _, node := range result.AST.Children {
		tag := strings.ToUpper(node.Value)
		flags := []flag{}
		for _, raw := range node.Flags {
			name, value, hasValue := strings.Cut(strings.TrimPrefix(raw, "--"), "=")
			f := flag{Name: name}
			if hasValue {
				// BuildKit resolves a flag's quotes and escapes while
				// splitting it off the line; the value is used as is.
				f.Value = str(value)
			}
			flags = append(flags, f)
		}
		args := []string{}
		for n := node.Next; n != nil; n = n.Next {
			args = append(args, n.Value)
		}
		isJSON := node.Attributes["json"]

		if tag == "FROM" {
			s := stage{Line: node.StartLine, Image: word(args[0]), Flags: flags, Instructions: []instruction{}}
			if len(args) == 3 {
				s.Name = str(strings.ToLower(word(args[2])))
			}
			out.Stages = append(out.Stages, s)
			continue
		}

		in := instruction{Tag: tag, Line: node.StartLine, Flags: flags}
		cmd := func() *command {
			if isJSON {
				return &command{Form: "exec", Argv: append([]string{}, args...)}
			}
			return &command{Form: "shell", Script: str(strings.Join(args, " "))}
		}
		docs := func() []heredoc {
			hs := []heredoc{}
			for _, h := range node.Heredocs {
				content := h.Content
				if h.Chomp {
					content = parser.ChompHeredocContent(content)
				}
				hs = append(hs, heredoc{Name: h.Name, Content: content, StripTabs: h.Chomp, Quoted: !h.Expand})
			}
			return hs
		}
		switch tag {
		case "RUN":
			in.Command = cmd()
			in.Heredocs = docs()
		case "CMD", "ENTRYPOINT", "SHELL":
			in.Command = cmd()
		case "COPY", "ADD":
			// docker build expands every source and the destination,
			// the JSON form's too; heredoc sources are file contents.
			words := make([]string, len(args))
			for i, a := range args {
				if !isJSON && strings.HasPrefix(a, "<<") {
					words[i] = a
				} else {
					words[i] = word(a)
				}
			}
			in.Sources = words[:len(words)-1]
			in.Destination = str(words[len(words)-1])
			in.Heredocs = docs()
		case "ENV":
			for i := 0; i+2 < len(args)+1 && i+1 < len(args); i += 3 {
				in.Vars = append(in.Vars, [2]*string{str(word(args[i])), str(word(args[i+1]))})
			}
		case "ARG":
			for _, a := range args {
				key, value, has := strings.Cut(a, "=")
				if has {
					in.Vars = append(in.Vars, [2]*string{str(word(key)), str(word(value))})
				} else {
					in.Vars = append(in.Vars, [2]*string{str(word(key)), nil})
				}
			}
		case "WORKDIR", "USER", "STOPSIGNAL":
			in.Value = str(word(strings.Join(args, " ")))
		}

		if len(out.Stages) == 0 {
			out.GlobalArgs = append(out.GlobalArgs, in)
		} else {
			last := &out.Stages[len(out.Stages)-1]
			last.Instructions = append(last.Instructions, in)
		}
	}
	return out
}
