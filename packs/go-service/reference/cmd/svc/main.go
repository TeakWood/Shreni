package main

import (
	"log"
	"net/http"

	"example.com/go-service-mini/internal/httpapi"
	"example.com/go-service-mini/internal/notes"
)

func main() {
	handler := httpapi.New(notes.NewStore())
	log.Println("listening on :8080")
	if err := http.ListenAndServe(":8080", handler.Routes()); err != nil {
		log.Fatal(err)
	}
}
