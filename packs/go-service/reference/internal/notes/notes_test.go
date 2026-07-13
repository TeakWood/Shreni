package notes

import (
	"errors"
	"testing"
)

func TestStore(t *testing.T) {
	tests := []struct {
		name string
		run  func(t *testing.T, s *Store)
	}{
		{"list returns the seed note", func(t *testing.T, s *Store) {
			if got := s.List(); len(got) != 1 || got[0].Title != "first note" {
				t.Fatalf("unexpected list: %+v", got)
			}
		}},
		{"get missing note returns ErrNotFound", func(t *testing.T, s *Store) {
			if _, err := s.Get(999); !errors.Is(err, ErrNotFound) {
				t.Fatalf("want ErrNotFound, got %v", err)
			}
		}},
		{"add appends a note", func(t *testing.T, s *Store) {
			n, err := s.Add("second")
			if err != nil {
				t.Fatalf("add: %v", err)
			}
			if n.ID != 2 || len(s.List()) != 2 {
				t.Fatalf("unexpected state after add: %+v", s.List())
			}
		}},
		{"add rejects an empty title", func(t *testing.T, s *Store) {
			if _, err := s.Add(""); err == nil {
				t.Fatal("want error for empty title")
			}
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			tc.run(t, NewStore())
		})
	}
}
