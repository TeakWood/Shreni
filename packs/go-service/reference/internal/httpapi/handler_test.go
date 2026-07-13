package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"example.com/go-service-mini/internal/notes"
)

func TestHandler(t *testing.T) {
	tests := []struct {
		name       string
		url        string
		wantStatus int
	}{
		{"health is ok", "/health", http.StatusOK},
		{"list notes", "/notes", http.StatusOK},
		{"get existing note", "/notes/1", http.StatusOK},
		{"get missing note is 404", "/notes/999", http.StatusNotFound},
		{"invalid id is 400", "/notes/abc", http.StatusBadRequest},
	}
	h := New(notes.NewStore()).Routes()
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.url, nil))
			if rec.Code != tc.wantStatus {
				t.Fatalf("GET %s: want %d, got %d", tc.url, tc.wantStatus, rec.Code)
			}
		})
	}
}
