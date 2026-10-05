// testpki writes the certificates and stores the local Kafka stand needs:
//
//	go run ./cmd/testpki -out testdata/pki
//
// Run it again to start over; the keys are new every time and are not committed.
package main

import (
	"flag"
	"fmt"
	"os"

	"enc-tool/kafka-agent/internal/testpki"
)

func main() {
	out := flag.String("out", "testdata/pki", "directory to write into")
	flag.Parse()

	p, err := testpki.New()
	if err == nil {
		err = p.WriteFiles(*out)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "testpki:", err)
		os.Exit(1)
	}
	fmt.Printf("wrote the stores, the client.properties files and a kafka-agent.yaml to %s\n", *out)
	fmt.Printf("store password %q, JKS key password %q\n", testpki.StorePassword, testpki.KeyPassword)
	fmt.Println("next: docker compose -f testdata/compose.yaml up -d, then")
	fmt.Printf("      kafka-agent --config %s/kafka-agent.yaml\n", *out)
}
