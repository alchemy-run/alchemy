package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
)

func handler(w http.ResponseWriter, r *http.Request) {
	message := os.Getenv("MESSAGE")
	deploymentId := os.Getenv("CLOUDFLARE_DEPLOYMENT_ID")

	fmt.Fprintf(w, "Hi, I'm a container and this is my message: %s, and my deployment ID is: %s", message, deploymentId)
}

func errorHandler(w http.ResponseWriter, r *http.Request) {
	// panics
	panic("This is a panic")
}

func main() {
	http.HandleFunc("/", handler)
	http.HandleFunc("/container", handler)
	http.HandleFunc("/error", errorHandler)
	log.Fatal(http.ListenAndServe(":8080", nil))
}
