// Package notes is the fixture's domain package: an in-memory note store.
package notes

import (
	"errors"
	"sync"
)

var ErrNotFound = errors.New("note not found")

type Note struct {
	ID    int    `json:"id"`
	Title string `json:"title"`
}

type Store struct {
	mu    sync.Mutex
	notes []Note
}

func NewStore() *Store {
	return &Store{notes: []Note{{ID: 1, Title: "first note"}}}
}

func (s *Store) List() []Note {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Note, len(s.notes))
	copy(out, s.notes)
	return out
}

func (s *Store) Get(id int) (Note, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, n := range s.notes {
		if n.ID == id {
			return n, nil
		}
	}
	return Note{}, ErrNotFound
}

func (s *Store) Add(title string) (Note, error) {
	if title == "" {
		return Note{}, errors.New("title must not be empty")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	n := Note{ID: len(s.notes) + 1, Title: title}
	s.notes = append(s.notes, n)
	return n, nil
}
